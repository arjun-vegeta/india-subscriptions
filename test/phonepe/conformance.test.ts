import { ChargeStatus, EventType } from '../../src/constants.js';
import { phonepe } from '../../src/providers/phonepe/index.js';
import { describeMerchantAdapterConformance, type ConformanceGateway } from '../helpers/merchant-adapter-conformance.js';
import { FakePhonePe } from './fake-gateway.js';
import { CLIENT_ID, CLIENT_SECRET, CLIENT_VERSION, CUSTOMER, MONTHLY_PLAN, RETURN_URL, WEBHOOK_PASSWORD, WEBHOOK_USERNAME } from './helpers.js';
import { Environment } from '../../src/constants.js';

/**
 * The merchant-adapter contract of `src/provider.ts`, run against the real facade and the real BillingScheduler with the
 * stateful PhonePe fake. PhonePe refuses a second redeem of an order that holds a debit (the fake's assumption, as the docs
 * are silent) and ties the debit to its notification.
 */
const START = '2026-01-01T05:00:00.000Z';
const FIRST_CHARGE = '2026-01-20T04:30:00.000Z';

describeMerchantAdapterConformance({
  name: 'PhonePe',
  startAt: START,
  firstChargeAt: FIRST_CHARGE,
  flags: { rejectsDuplicateIds: true, notificationDictatesChargeId: true },
  setup: (clock) => {
    const fake = new FakePhonePe(clock.nowMs);
    const adapter = phonepe(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        clientVersion: CLIENT_VERSION,
        environment: Environment.Test,
        redirectUrl: RETURN_URL,
        webhookUsername: WEBHOOK_USERNAME,
        webhookPassword: WEBHOOK_PASSWORD,
      },
      { fetch: fake.fetch, now: clock.now, maxRetries: 0 },
    );
    const firstSubscription = (): string => {
      const [id] = [...fake.subscriptions.keys()];
      if (id === undefined) throw new Error('no authorised subscription at the fake gateway');
      return id;
    };
    const gateway: ConformanceGateway = {
      authorise: (subscription) => {
        fake.authorise(subscription.id);
        return { checkoutResult: { merchantSubscriptionId: subscription.id } };
      },
      chargeRequestIds: () => fake.redeemRequests,
      notificationIds: () => fake.notifyRequests,
      debitCount: () => fake.debits.size,
      // PhonePe's redemptions are always in flight until PhonePe settles them: nothing to hold.
      holdNextCharge: () => undefined,
      settle: (chargeId, outcome) => fake.settle(chargeId, outcome === ChargeStatus.Succeeded ? 'succeeded' : 'failed'),
      loseNextChargeAnswer: () => {
        fake.dropNextRedeem = 'answer';
      },
      loseNextChargeRequest: () => {
        fake.dropNextRedeem = 'request';
      },
      hideDebitsUntil: (iso) => {
        fake.hideUntilMs = Date.parse(iso);
      },
      debitWebhook: (chargeId, outcome) => fake.debitWebhook(chargeId, outcome === ChargeStatus.Succeeded ? 'succeeded' : 'failed'),
      mandateWebhook: (event) =>
        fake.mandateWebhook(
          firstSubscription(),
          event === EventType.SubscriptionPaused ? 'paused' : event === EventType.SubscriptionResumed ? 'unpaused' : 'cancelled',
        ),
      dictatedChargeIds: () => fake.notifyRequests,
    };
    return {
      adapter,
      gateway,
      createInput: { reference: 'conf_sub_1', plan: { ...MONTHLY_PLAN }, customer: CUSTOMER, startAt: FIRST_CHARGE, returnUrl: RETURN_URL },
    };
  },
});
