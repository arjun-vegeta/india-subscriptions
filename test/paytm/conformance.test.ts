/**
 * The merchant-scheduled adapter conformance suite (`test/helpers/merchant-adapter-conformance.ts`) run on the Paytm adapter in
 * merchant mode, against the stateful fake of `fake-gateway.ts`: the real facade, the real `BillingScheduler` and the real
 * adapter; only the network is scripted. Paytm refuses a renew order id it already holds (325), so `rejectsDuplicateIds` is
 * true and the lag case (`hideDebitsUntil`) applies.
 */
import { Environment, IntervalUnit } from '../../src/constants.js';
import { paytm } from '../../src/providers/paytm/index.js';
import { describeMerchantAdapterConformance, type ConformanceGateway, type DebitOutcome } from '../helpers/merchant-adapter-conformance.js';
import { CUSTOMER, KEY, MID, SALT } from './helpers.js';
import { FakePaytm } from './fake-gateway.js';

const PLAN = { name: 'Conformance monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } } as const;

describeMerchantAdapterConformance({
  name: 'Paytm (merchant-collected UPI mandate)',
  startAt: '2026-01-01T05:00:00.000Z',
  firstChargeAt: '2026-01-20T04:30:00.000Z',
  flags: { rejectsDuplicateIds: true },
  setup(clock) {
    const fake = new FakePaytm(clock.nowMs);
    const reference = 'conf_ptm_1';
    const gateway: ConformanceGateway = {
      authorise: (subscription) => ({ checkoutResult: fake.authorise(subscription) }),
      chargeRequestIds: () => fake.renewRequestIds,
      notificationIds: () => fake.notifications.map((entry) => entry.referenceId),
      debitCount: () => fake.debits.size,
      // Paytm's debits are always in flight until the bank answers.
      holdNextCharge: () => undefined,
      settle: (chargeId, outcome: DebitOutcome) => fake.settle(chargeId, outcome),
      loseNextChargeAnswer: () => void (fake.loseNextRenew = 'answer'),
      loseNextChargeRequest: () => void (fake.loseNextRenew = 'request'),
      hideDebitsUntil: (iso) => void (fake.hideDebitsUntilMs = Date.parse(iso)),
      debitWebhook: (chargeId, outcome) => fake.paymentWebhook(chargeId, outcome),
      mandateWebhook: (event) => fake.mandateWebhook(event),
    };
    const adapter = paytm(
      { mid: MID, merchantKey: KEY, website: 'WEBSTAGING', environment: Environment.Test },
      { fetch: fake.fetch, now: clock.now, maxRetries: 0, generateSalt: () => SALT },
    );
    return {
      adapter,
      gateway,
      createInput: { reference, plan: { ...PLAN }, customer: CUSTOMER, startAt: '2026-01-20T04:30:00.000Z' },
    };
  },
});

