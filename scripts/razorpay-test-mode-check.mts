/**
 * Runs the Razorpay adapter against Razorpay **test mode** and prints a
 * pass/fail table. API-only: it does not open Checkout, so it covers
 * everything up to (not including) the customer's authorisation.
 *
 * Credentials come from RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET and must be
 * test-mode keys (`rzp_test_...`). Nothing secret is printed.
 *
 *   RAZORPAY_KEY_ID=rzp_test_xxx RAZORPAY_KEY_SECRET=xxx npx tsx scripts/razorpay-test-mode-check.mts
 *
 * Note: Razorpay has no API to delete plans, so each run leaves one test-mode
 * plan and one cancelled test-mode subscription behind.
 */
import {
  CancelMode,
  CheckoutKind,
  ErrorCode,
  IntervalUnit,
  SchedulingMode,
  SubscriptionStatus,
  isSubscriptionError,
  razorpay,
} from '../src/index.js';

const TEST_KEY_PREFIX = 'rzp_test_';
const keyId = process.env.RAZORPAY_KEY_ID ?? '';
const keySecret = process.env.RAZORPAY_KEY_SECRET ?? '';
if (!keyId.startsWith(TEST_KEY_PREFIX) || keySecret === '') {
  console.error(`Set RAZORPAY_KEY_ID (must start with ${TEST_KEY_PREFIX}) and RAZORPAY_KEY_SECRET. Live keys are refused.`);
  process.exit(2);
}

const provider = razorpay({ keyId, keySecret });
const results: Array<{ check: string; ok: boolean; detail: string }> = [];

function describe(error: unknown): string {
  if (isSubscriptionError(error)) {
    return `${error.code}${error.providerCode ? `/${error.providerCode}` : ''}: ${error.message}`.slice(0, 220);
  }
  return String(error instanceof Error ? error.message : error).slice(0, 220);
}

async function check(name: string, run: () => Promise<string>): Promise<boolean> {
  try {
    results.push({ check: name, ok: true, detail: await run() });
    return true;
  } catch (error) {
    results.push({ check: name, ok: false, detail: describe(error) });
    return false;
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const stamp = Date.now().toString(36);
const reference = `check_${stamp}`;
const DAY_MS = 24 * 60 * 60 * 1000;
let planId = '';
let subscriptionId = '';

await check('create plan (₹499 monthly)', async () => {
  const plan = await provider.createPlan({
    name: `Verification plan ${stamp}`,
    amount: 49900,
    interval: { unit: IntervalUnit.Month, count: 1 },
  });
  planId = plan.id;
  expect(plan.amount === 49900, `amount came back as ${plan.amount}, expected 49900 paise`);
  expect(plan.interval?.unit === IntervalUnit.Month && plan.interval.count === 1, 'interval did not round-trip');
  return `plan ${plan.id}`;
});

if (planId) {
  await check('fetch plan', async () => {
    const plan = await provider.getPlan(planId);
    expect(plan.id === planId && plan.amount === 49900, 'fetched plan differs from created plan');
    return 'round-trips';
  });

  await check('create subscription: 7-day trial, ₹99 upfront, 6 cycles', async () => {
    const before = Date.now();
    const subscription = await provider.createSubscription({
      reference,
      plan: planId,
      customer: { name: 'Test User', email: 'test@example.com', phone: '9999999999' },
      trial: { days: 7 },
      upfrontAmount: 9900,
      totalCycles: 6,
    });
    subscriptionId = subscription.id;
    expect(subscription.status === SubscriptionStatus.Created, `status ${subscription.status} (${subscription.providerStatus})`);
    expect(subscription.scheduling === SchedulingMode.Gateway, 'scheduling should be gateway');
    expect(subscription.reference === reference, `reference came back as ${subscription.reference}`);
    expect(subscription.totalCycles === 6, `totalCycles came back as ${subscription.totalCycles}`);
    expect(subscription.checkout?.kind === CheckoutKind.RazorpayCheckout, 'no Razorpay checkout instruction');
    const startAt = subscription.startAt ? Date.parse(subscription.startAt) : NaN;
    expect(Math.abs(startAt - (before + 7 * DAY_MS)) < 5 * 60 * 1000, `first charge at ${subscription.startAt}, expected about 7 days out`);
    const hosted = subscription.checkout.kind === CheckoutKind.RazorpayCheckout ? subscription.checkout.hostedUrl : undefined;
    return `subscription ${subscription.id}, status ${subscription.providerStatus}, hosted page ${hosted ? 'present' : 'absent'}`;
  });
}

if (subscriptionId) {
  await check('fetch subscription', async () => {
    const subscription = await provider.getSubscription(subscriptionId);
    expect(subscription.id === subscriptionId, 'id mismatch');
    expect(subscription.planId === planId, 'plan id mismatch');
    expect(subscription.reference === reference, 'reference not read back from notes');
    return `status ${subscription.status} (${subscription.providerStatus}), remaining ${subscription.remainingCycles}`;
  });

  await check('list charges before authorisation', async () => {
    const charges = await provider.listCharges(subscriptionId);
    return `${charges.length} charge(s)`;
  });

  await check('pause before authorisation is refused cleanly', async () => {
    try {
      await provider.pauseSubscription(subscriptionId);
    } catch (error) {
      expect(isSubscriptionError(error), `non-library error: ${describe(error)}`);
      return `refused: ${describe(error)}`;
    }
    throw new Error('pause succeeded on a subscription that was never authorised');
  });

  await check('cancel immediately', async () => {
    const subscription = await provider.cancelSubscription(subscriptionId, { mode: CancelMode.Immediately });
    expect(subscription.status === SubscriptionStatus.Cancelled, `status ${subscription.status} (${subscription.providerStatus})`);
    return `status ${subscription.providerStatus}`;
  });
}

await check('unknown subscription maps to NOT_FOUND', async () => {
  try {
    await provider.getSubscription('sub_doesNotExist0000');
  } catch (error) {
    expect(isSubscriptionError(error) && error.code === ErrorCode.NotFound, `got ${describe(error)}`);
    return describe(error);
  }
  throw new Error('fetch of a non-existent subscription succeeded');
});

await check('invalid plan is rejected with VALIDATION', async () => {
  try {
    await provider.createSubscription({
      plan: 'plan_doesNotExist0000',
      customer: { name: 'Test User', email: 'test@example.com', phone: '9999999999' },
      totalCycles: 3,
    });
  } catch (error) {
    expect(isSubscriptionError(error), `non-library error: ${describe(error)}`);
    return describe(error);
  }
  throw new Error('subscription was created against a non-existent plan');
});

const width = Math.max(...results.map((result) => result.check.length));
console.log('\nRazorpay test mode check\n');
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.check.padEnd(width)}  ${result.detail}`);
}
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
