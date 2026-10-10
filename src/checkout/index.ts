/**
 * Browser entry (`india-subscriptions/checkout`): executes the
 * `CheckoutInstruction` your server got back from `createSubscription`.
 * Dependency-free apart from zod, never touches a secret and imports no Node
 * modules. It only sees what the server chose to return.
 */
import { CheckoutKind, ErrorCode, Provider } from '../constants.js';
import { SubscriptionError, parseInput } from '../errors.js';
import { CheckoutInstructionSchema, type CheckoutInstruction } from '../schemas.js';
import { openCashfreeCheckout } from './cashfree.js';
import type { CheckoutEnv } from './env.js';
import { redirectTo, submitForm } from './navigate.js';
import { openRazorpayCheckout } from './razorpay.js';
import { OpenCheckoutOptionsSchema, type CheckoutOutcome, type OpenCheckoutOptions } from './schemas.js';

/**
 * Carries out whatever the instruction asks of the browser.
 *
 * - `redirect` / `form_post`: navigates; resolves `redirecting`.
 * - `razorpay_checkout`: opens the modal; resolves `completed` (POST `result`
 *   to your server and call `verifyCheckout`), `dismissed` or `failed`.
 * - `cashfree_checkout`: hands over to Cashfree's hosted checkout; resolves
 *   `failed` on an immediate error, else `redirecting`.
 *
 * - `apple_storekit` / `google_play_billing`: a purchase starts on the device, not in the browser; throws `UNSUPPORTED`.
 *
 * Throws `SubscriptionError`: `VALIDATION` (bad instruction or options),
 * `CONFIG` (no DOM), `PROVIDER_UNAVAILABLE` (gateway script failed to load).
 */
export async function openCheckout(
  instruction: CheckoutInstruction,
  options?: OpenCheckoutOptions,
  env?: Partial<CheckoutEnv>,
): Promise<CheckoutOutcome> {
  const parsed = parseInput(CheckoutInstructionSchema, instruction, 'checkout instruction');
  parseInput(OpenCheckoutOptionsSchema, options ?? {}, 'checkout options');
  switch (parsed.kind) {
    case CheckoutKind.Redirect:
      return redirectTo(parsed, env);
    case CheckoutKind.FormPost:
      return submitForm(parsed, env);
    case CheckoutKind.RazorpayCheckout:
      return openRazorpayCheckout(parsed, options, env);
    case CheckoutKind.CashfreeCheckout:
      return openCashfreeCheckout(parsed, options, env);
    case CheckoutKind.AppleStoreKit:
      throw storeCheckoutUnsupported(Provider.AppStore, 'StoreKit');
    case CheckoutKind.GooglePlayBilling:
      throw storeCheckoutUnsupported(Provider.GooglePlay, 'Google Play Billing');
    default: {
      const unreachable: never = parsed;
      return unreachable;
    }
  }
}

function storeCheckoutUnsupported(provider: Provider, api: string): SubscriptionError {
  return new SubscriptionError(
    ErrorCode.Unsupported,
    `${api} purchases start on the device: pass the instruction to the native SDK, not to the browser helper`,
    { provider },
  );
}

export { openCashfreeCheckout, CASHFREE_MODE } from './cashfree.js';
export { openRazorpayCheckout, buildRazorpayOptions } from './razorpay.js';
export { redirectTo, submitForm } from './navigate.js';
export { loadScript } from './env.js';
export type { CheckoutDocument, CheckoutElement, CheckoutEnv, CheckoutParentNode, CheckoutWindow } from './env.js';
export {
  CheckoutErrorSchema,
  CheckoutOutcomeSchema,
  OpenCheckoutOptionsSchema,
  type CheckoutError,
  type CheckoutOutcome,
  type OpenCheckoutOptions,
} from './schemas.js';
export { CheckoutStatus, ScriptUrl } from './constants.js';
export { SubscriptionError } from '../errors.js';
export { ErrorCode } from '../constants.js';
export type { CheckoutInstruction } from '../schemas.js';
