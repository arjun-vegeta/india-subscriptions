import { describe, expect, it } from 'vitest';
import { Environment, Provider } from '../../src/constants.js';
import type { FetchLike } from '../../src/http.js';
import { payu } from '../../src/providers/payu/index.js';
import { BillingScheduler, MemorySchedulerStore, CycleStatus } from '../../src/scheduler/index.js';
import { CUSTOMER, KEY, MONTHLY_PLAN, SALT, signPayment } from './helpers.js';

/**
 * End-to-end through the real billing scheduler: createSubscription -> verifyCheckout -> register / activate ->
 * pre-debit -> debit, and a debit whose answer is lost. The fake PayU below answers by `command` and keeps a
 * record of debits the way a real gateway would, so a retry that reuses the txnid cannot debit twice.
 */
class FakePayU {
  readonly commands: { command: string; var1: Record<string, unknown> | string }[] = [];
  /** Debits PayU holds, by merchant txnid. */
  readonly debits = new Map<string, string>();
  /** Lose the answer of the next `si_transaction` before PayU sees it. */
  dropNextDebit = false;

  readonly fetch: FetchLike = async (_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    const command = form.get('command') ?? '';
    const raw = form.get('var1') ?? '';
    const var1 = raw.startsWith('{') ? (JSON.parse(raw) as Record<string, unknown>) : raw;
    this.commands.push({ command, var1 });
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    switch (command) {
      case 'pre_debit_SI':
        return reply({ invoiceid: '76323425', approvedStatus: 'na', invoiceStatus: 'unpaid', amount: '499.00', status: 1, message: 'Invoice Created Successfully', action: 'MANDATE_PRE_DEBIT' });
      case 'si_transaction': {
        if (this.dropNextDebit) {
          this.dropNextDebit = false;
          throw new TypeError('fetch failed');
        }
        const debit = var1 as Record<string, string>;
        this.debits.set(debit.txnid!, '30141596997');
        return reply({
          status: 1,
          message: 'Transaction Processed successfully',
          details: { [debit.txnid!]: { authpayuid: debit.authpayuid, transactionid: debit.txnid, amount: debit.amount, payuid: '', status: 'captured', field9: 'Transaction Completed Successfully' } },
        });
      }
      case 'verify_payment': {
        const txnid = String(var1);
        if (!this.debits.has(txnid)) {
          return reply({ status: 0, msg: '0 out of 1 Transactions Fetched Successfully', transaction_details: { [txnid]: { mihpayid: 'Not Found', status: 'Not Found' } } });
        }
        return reply({
          status: 1,
          msg: '1 out of 1 Transactions Fetched Successfully',
          transaction_details: { [txnid]: { mihpayid: this.debits.get(txnid), txnid, transaction_amount: '499.00', status: 'success', unmappedstatus: 'captured', payment_source: 'sirecurring' } },
        });
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };
}

const T0 = '2026-01-01T00:00:00.000Z';
/** 15 Jan 2026, 10:00 IST. */
const DUE = '2026-01-15T04:30:00.000Z';
const SECOND_DUE = '2026-02-15T04:30:00.000Z';

describe('PayUProvider driven by the BillingScheduler', () => {
  it('registers, notifies 48 hours ahead, debits with the notified invoice number, and recovers a lost answer without a second debit', async () => {
    let now = new Date(T0);
    const fake = new FakePayU();
    const provider = payu(
      { key: KEY, salt: SALT, environment: Environment.Test, successUrl: 'https://merchant.example/payu/success' },
      { fetch: fake.fetch, now: () => now, maxRetries: 0 },
    );
    const scheduler = new BillingScheduler({
      store: new MemorySchedulerStore(),
      resolveProvider: () => provider,
      now: () => now,
    });
    const tickAt = (iso: string) => {
      now = new Date(iso);
      return scheduler.tick();
    };

    // 1. The subscription: no network call, a form to post.
    const subscription = await provider.createSubscription({
      plan: { ...MONTHLY_PLAN },
      customer: CUSTOMER,
      startAt: DUE,
      reference: 'order_100',
    });
    expect(fake.commands).toHaveLength(0);

    // 2. The scheduler waits for the customer.
    const schedule = await scheduler.register({
      provider: Provider.PayU,
      subscriptionId: subscription.id,
      reference: subscription.reference,
      amount: subscription.amount!,
      interval: subscription.interval!,
      firstChargeAt: subscription.startAt!,
      customer: CUSTOMER,
      awaitingAuthorization: true,
    });

    // 3. The customer returns from PayU: verify, then hand the composite id to the scheduler.
    const verification = await provider.verifyCheckout(
      signPayment({
        mihpayid: '25511473084',
        mode: 'CC',
        status: 'success',
        unmappedstatus: 'captured',
        txnid: 'order_100',
        amount: '2.00',
        productinfo: 'Pro monthly',
        firstname: 'Ashish Kumar',
        email: 'ashish@example.com',
        udf1: '',
        udf2: '',
        udf3: '',
        udf4: '',
        udf5: '',
        payment_source: 'sist',
        PG_TYPE: 'CC-PG',
        cardToken: 'tok_1',
        addedon: '2026-01-01 05:30:00',
        error: 'E000',
      }),
    );
    expect(verification).toMatchObject({ authorized: true, subscriptionId: 'card:25511473084' });
    await scheduler.activate(schedule.id, { subscriptionId: verification.subscriptionId, firstChargeAt: DUE });

    // 4. Nothing is due yet.
    expect((await tickAt('2026-01-02T00:00:00.000Z')).notified).toBe(0);

    // 5. 48 hours before the due date: the pre-debit notification.
    expect((await tickAt('2026-01-13T04:30:00.000Z')).notified).toBe(1);
    const preDebit = fake.commands.find((entry) => entry.command === 'pre_debit_SI')!.var1 as Record<string, string>;
    expect(preDebit).toMatchObject({ authpayuid: '25511473084', amount: '499.00', debitDate: '2026-01-15' });
    expect(preDebit.requestId).toMatch(/^ntf_/);

    // 6. The due date: the debit, with the invoice number the notification carried.
    const due = await tickAt(DUE);
    expect(due.succeeded).toBe(1);
    const debit = fake.commands.find((entry) => entry.command === 'si_transaction')!.var1 as Record<string, string>;
    expect(debit).toMatchObject({ authpayuid: '25511473084', amount: '499.00' });
    expect(debit.invoiceDisplayNumber).toBe(preDebit.invoiceDisplayNumber);
    expect(debit.txnid).toMatch(/^chg_/);

    // 7. Second cycle: the answer of the debit is lost before PayU sees it.
    await tickAt('2026-02-13T04:30:00.000Z');
    fake.dropNextDebit = true;
    const lost = await tickAt(SECOND_DUE);
    expect(lost.succeeded).toBe(0);
    expect(lost.errors[0]?.code).toBe('OUTCOME_UNKNOWN');

    // 8. The next tick asks PayU (NOT_FOUND: the debit never arrived), then raises it again with the same txnid.
    const recovered = await tickAt('2026-02-15T05:00:00.000Z');
    expect(recovered.succeeded).toBe(1);
    const debitCalls = fake.commands.filter((entry) => entry.command === 'si_transaction');
    expect(debitCalls).toHaveLength(3);
    const [, second, third] = debitCalls.map((entry) => (entry.var1 as Record<string, string>).txnid);
    expect(second).toBe(third);
    expect(fake.debits.size).toBe(2);

    const cycles = await scheduler.listCycles(schedule.id);
    expect(cycles.slice(0, 2).map((cycle) => cycle.status)).toEqual([CycleStatus.Succeeded, CycleStatus.Succeeded]);
  });
});
