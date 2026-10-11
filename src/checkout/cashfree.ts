import type { z } from 'zod';
import { z as zod } from 'zod';
import { CheckoutKind, Environment, ErrorCode, ProductKind, Provider } from '../constants.js';
import { parseInput, SubscriptionError } from '../errors.js';
import { CashfreeCheckoutSchema } from '../schemas.js';
import {
  CashfreeCheckoutOption,
  CashfreeInitOption,
  CashfreeMode,
  CheckoutStatus,
  DEFAULT_CASHFREE_REDIRECT_TARGET,
  GatewayMethod,
  GlobalName,
  ScriptUrl,
} from './constants.js';
import { loadScript, readGlobal, resolveEnv, type CheckoutEnv } from './env.js';
import {
  CheckoutErrorSchema,
  OpenCheckoutOptionsSchema,
  type CheckoutOutcome,
  type OpenCheckoutOptions,
} from './schemas.js';

export type CashfreeCheckout = z.infer<typeof CashfreeCheckoutSchema>;

/** cashfree.js `mode` for each environment. [cashfree.md §7.1: `"sandbox" // or production`] */
export const CASHFREE_MODE: Record<Environment, CashfreeMode> = {
  [Environment.Test]: CashfreeMode.Sandbox,
  [Environment.Live]: CashfreeMode.Production,
};

/**
 * Cashfree.js `checkout` for a one-time payment. [web guide: `cashfree.checkout({ paymentSessionId, redirectTarget })`]
 * These names live here, not in `constants.ts`, because the subscription helper's constants are shared.
 */
const OneTimeCheckout = {
  /** The method called on the Cashfree object. */
  Method: 'checkout',
  /** Key of the payment session id in the options. */
  PaymentSessionId: 'paymentSessionId',
} as const;

/** What `subscriptionsCheckout(...)` resolves with: on failure `result.error.message`. [cashfree.md §7.1] */
const CheckoutResultShape = zod.looseObject({ error: CheckoutErrorSchema.nullish() }).nullish();

function unavailable(message: string): SubscriptionError {
  return new SubscriptionError(ErrorCode.ProviderUnavailable, message, { provider: Provider.Cashfree });
}

/**
 * `cashfree_checkout`: loads cashfree.js (once), initialises it with the mode
 * for `instruction.environment`, and calls
 * `subscriptionsCheckout({ subsSessionId, redirectTarget })`. When the
 * instruction has `productKind: one_time`, it calls
 * `checkout({ paymentSessionId, redirectTarget })` instead, with the payment
 * session id.
 *
 * A result carrying `error` becomes `failed`. Otherwise the hosted checkout
 * has taken over and the customer comes back to your `return_url`: the outcome
 * is `redirecting`, and the real result must be confirmed server-side (return
 * URL fields or webhook), never from the browser.
 */
export async function openCashfreeCheckout(
  instruction: CashfreeCheckout,
  options?: OpenCheckoutOptions,
  env?: Partial<CheckoutEnv>,
): Promise<CheckoutOutcome> {
  const parsed = parseInput(CashfreeCheckoutSchema, instruction, `${CheckoutKind.CashfreeCheckout} checkout instruction`);
  const display = parseInput(OpenCheckoutOptionsSchema, options ?? {}, 'checkout options');
  const resolved = resolveEnv(env);

  let factory = readGlobal(resolved.window, GlobalName.Cashfree);
  if (typeof factory !== 'function') {
    await loadScript(ScriptUrl.Cashfree, resolved, Provider.Cashfree);
    factory = readGlobal(resolved.window, GlobalName.Cashfree);
  }
  if (typeof factory !== 'function') {
    throw unavailable('The Cashfree script loaded but did not define Cashfree');
  }

  const sdk: unknown = Reflect.apply(factory, undefined, [
    { [CashfreeInitOption.Mode]: CASHFREE_MODE[parsed.environment] },
  ]);
  const oneTime = parsed.productKind === ProductKind.OneTime;
  const method = oneTime ? OneTimeCheckout.Method : GatewayMethod.CashfreeSubscriptionsCheckout;
  const checkout: unknown = sdk !== null && typeof sdk === 'object' ? Reflect.get(sdk, method) : undefined;
  if (typeof checkout !== 'function') {
    throw unavailable(`The Cashfree SDK has no ${method} method`);
  }

  const redirectTarget = display.redirectTarget ?? DEFAULT_CASHFREE_REDIRECT_TARGET;
  const checkoutOptions = oneTime
    ? { [OneTimeCheckout.PaymentSessionId]: parsed.sessionId, [CashfreeCheckoutOption.RedirectTarget]: redirectTarget }
    : { [CashfreeCheckoutOption.SubsSessionId]: parsed.sessionId, [CashfreeCheckoutOption.RedirectTarget]: redirectTarget };

  let raw: unknown;
  try {
    raw = await Reflect.apply(checkout, sdk, [checkoutOptions]);
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined;
    return { status: CheckoutStatus.Failed, error: message === undefined ? {} : { message } };
  }

  const result = CheckoutResultShape.safeParse(raw);
  if (result.success && result.data?.error) {
    return { status: CheckoutStatus.Failed, error: result.data.error };
  }
  return { status: CheckoutStatus.Redirecting };
}
