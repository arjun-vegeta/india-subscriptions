import type { Subscriptions } from '../client.js';

/**
 * The slice of the facade (`Subscriptions`) the purchase module needs. `Subscriptions` satisfies it structurally, and a
 * test can satisfy it with a small fake.
 *
 * `Purchases` always goes through the host and never reaches for an adapter: the facade registers billing schedules on
 * `create`, starts them on `verifyCheckout`, and checks that a verified result belongs to the expected id.
 */
export interface PurchaseHost extends Pick<Subscriptions, 'providers' | 'capabilities' | 'create' | 'get' | 'verifyCheckout'> {
  readonly payments: Pick<Subscriptions['payments'], 'create' | 'get' | 'verify'>;
}
