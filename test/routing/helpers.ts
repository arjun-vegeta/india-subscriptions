import { PaymentMethod, Provider, ProviderKind, SchedulingMode } from '../../src/constants.js';
import type { Capabilities } from '../../src/schemas.js';
import {
  MemoryRoutingStatsStore,
  RouteOutcomeKind,
  RouteOutcomeResult,
  Router,
  type RouterOptions,
  type RouteRequest,
  type RoutingStrategyInput,
} from '../../src/routing/index.js';
import { ProductKind } from '../../src/constants.js';

export const T0 = Date.parse('2026-11-22T10:30:00.000Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** A clock the test moves by hand. */
export class FakeClock {
  constructor(private ms: number = T0) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
  iso(offsetMs = 0): string {
    return new Date(this.ms + offsetMs).toISOString();
  }
}

type Overrides = Partial<Capabilities>;

/**
 * A capability set. The defaults describe a plain gateway; use `GATEWAYS` for
 * the five gateways with the subscription capabilities of the capability matrix
 * in `docs/reference/generated/capabilities.md`.
 */
export function caps(provider: Provider, overrides: Overrides = {}): Capabilities {
  return {
    provider,
    kind: ProviderKind.Gateway,
    scheduling: [SchedulingMode.Gateway],
    gatewayPlans: false,
    trial: true,
    upfrontAmount: true,
    quantity: false,
    pause: false,
    resume: false,
    cancel: true,
    cancelAtPeriodEnd: false,
    changePlan: false,
    merchantCharges: false,
    merchantPreDebitNotification: false,
    listCharges: false,
    refunds: true,
    signedWebhooks: true,
    idempotencyKeys: false,
    paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card],
    oneTimePayments: true,
    oneTimePaymentMethods: [PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.NetBanking],
    ...overrides,
  };
}

const { Upi, Card, ENach, NetBanking, Wallet } = PaymentMethod;

/**
 * The five gateways. Subscription columns (`pause`, `quantity`, `cancelAtPeriodEnd`, `changePlan`, `paymentMethods`,
 * `trial`, `upfrontAmount`, `refunds`) follow the capability matrix in `docs/reference/generated/capabilities.md`.
 * `oneTimePayments` and `oneTimePaymentMethods` are fixtures for routing tests: PhonePe is left without one-time
 * payments so the product-kind filter has something to exclude.
 */
export const GATEWAYS: Record<'razorpay' | 'cashfree' | 'payu' | 'phonepe' | 'paytm', Capabilities> = {
  razorpay: caps(Provider.Razorpay, {
    quantity: true,
    pause: true,
    resume: true,
    cancelAtPeriodEnd: true,
    changePlan: true,
    paymentMethods: [Card, Upi, ENach],
    oneTimePaymentMethods: [Card, Upi, NetBanking, Wallet],
  }),
  cashfree: caps(Provider.Cashfree, {
    pause: true,
    resume: true,
    changePlan: true,
    paymentMethods: [Upi, Card, ENach],
    oneTimePaymentMethods: [Upi, Card, NetBanking, Wallet],
  }),
  payu: caps(Provider.PayU, {
    paymentMethods: [Card, Upi, ENach],
    oneTimePaymentMethods: [Card, Upi, NetBanking, Wallet],
  }),
  phonepe: caps(Provider.PhonePe, {
    paymentMethods: [Upi],
    oneTimePayments: false,
    oneTimePaymentMethods: [],
  }),
  paytm: caps(Provider.Paytm, {
    pause: true,
    resume: true,
    paymentMethods: [Upi, Card, ENach],
    oneTimePaymentMethods: [Upi, Card, NetBanking, Wallet],
  }),
};

export const ALL_GATEWAYS = Object.values(GATEWAYS);

/** The app stores: never candidates, whatever they can do. */
export const STORES: Capabilities[] = [
  caps(Provider.AppStore, { kind: ProviderKind.Store, paymentMethods: [], oneTimePaymentMethods: [] }),
  caps(Provider.GooglePlay, { kind: ProviderKind.Store, paymentMethods: [], oneTimePaymentMethods: [] }),
];

export interface Harness {
  router: Router;
  clock: FakeClock;
  stats: MemoryRoutingStatsStore;
}

export function makeRouter(
  options: { capabilities?: Capabilities[]; strategy?: RoutingStrategyInput; stats?: RouterOptions['stats'] } = {},
): Harness {
  const clock = new FakeClock();
  const stats = new MemoryRoutingStatsStore();
  const router = new Router({
    capabilities: () => options.capabilities ?? ALL_GATEWAYS,
    strategy: options.strategy,
    stats: options.stats ?? stats,
    now: clock.now,
  });
  return { router, clock, stats };
}

export const SUBSCRIPTION: RouteRequest = { kind: ProductKind.Subscription, amount: 49_900 };
export const PAYMENT: RouteRequest = { kind: ProductKind.OneTime, amount: 49_900 };

/** Records `count` identical outcomes. */
export async function recordMany(
  router: Router,
  provider: Provider,
  result: RouteOutcomeResult,
  count: number,
  kind: RouteOutcomeKind = RouteOutcomeKind.Authorization,
  paymentMethod?: PaymentMethod,
): Promise<void> {
  for (let i = 0; i < count; i += 1) await router.record({ provider, kind, result, paymentMethod });
}
