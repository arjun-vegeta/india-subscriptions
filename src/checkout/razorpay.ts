import type { z } from 'zod';
import { z as zod } from 'zod';
import { CheckoutKind, ErrorCode, Provider } from '../constants.js';
import { parseInput, parseResponse, SubscriptionError } from '../errors.js';
import { CheckoutResultSchema, RazorpayCheckoutSchema } from '../schemas.js';
import {
  CheckoutStatus,
  GatewayMethod,
  GlobalName,
  RazorpayEvent,
  RazorpayModalKey,
  RazorpayOption,
  RazorpayPrefillKey,
  RazorpayThemeKey,
  ScriptUrl,
} from './constants.js';
import { loadScript, readGlobal, resolveEnv, type CheckoutEnv } from './env.js';
import {
  CheckoutErrorSchema,
  OpenCheckoutOptionsSchema,
  type CheckoutOutcome,
  type OpenCheckoutOptions,
} from './schemas.js';

export type RazorpayCheckout = z.infer<typeof RazorpayCheckoutSchema>;

const PaymentFailedEventSchema = zod.looseObject({ error: CheckoutErrorSchema.optional() });

/**
 * Builds the Standard Checkout options object for a subscription.
 * [razorpay.md §6.2] No `amount`, `currency` or `order_id`: the subscription
 * carries them. With `callback_url` the docs use no `handler` ("callback_url OR
 * handler"), so exactly one of the two is set.
 */
export function buildRazorpayOptions(
  instruction: RazorpayCheckout,
  options: OpenCheckoutOptions,
  hooks: { onHandler: (response: unknown) => void; onDismiss: () => void },
): Record<string, unknown> {
  const built: Record<string, unknown> = {
    [RazorpayOption.Key]: instruction.keyId,
    [RazorpayOption.SubscriptionId]: instruction.subscriptionId,
  };
  if (options.name !== undefined) built[RazorpayOption.Name] = options.name;
  if (options.description !== undefined) built[RazorpayOption.Description] = options.description;
  if (options.image !== undefined) built[RazorpayOption.Image] = options.image;

  if (instruction.callbackUrl !== undefined) {
    built[RazorpayOption.CallbackUrl] = instruction.callbackUrl;
  } else {
    built[RazorpayOption.Handler] = hooks.onHandler;
  }

  const customer = instruction.prefill;
  if (customer) {
    const prefill: Record<string, string> = {};
    if (customer.name !== undefined) prefill[RazorpayPrefillKey.Name] = customer.name;
    if (customer.email !== undefined) prefill[RazorpayPrefillKey.Email] = customer.email;
    if (customer.phone !== undefined) prefill[RazorpayPrefillKey.Contact] = customer.phone;
    if (Object.keys(prefill).length > 0) built[RazorpayOption.Prefill] = prefill;
  }
  if (options.notes !== undefined) built[RazorpayOption.Notes] = options.notes;
  if (options.theme !== undefined) built[RazorpayOption.Theme] = { [RazorpayThemeKey.Color]: options.theme.color };
  built[RazorpayOption.Modal] = { [RazorpayModalKey.OnDismiss]: hooks.onDismiss };
  return built;
}

function method(target: unknown, name: GatewayMethod): ((...args: unknown[]) => unknown) | undefined {
  if (target === null || typeof target !== 'object') return undefined;
  const candidate: unknown = Reflect.get(target, name);
  if (typeof candidate !== 'function') return undefined;
  return (...args: unknown[]) => Reflect.apply(candidate, target, args);
}

function providerError(message: string, cause?: unknown): SubscriptionError {
  return new SubscriptionError(ErrorCode.ProviderError, message, { provider: Provider.Razorpay, cause });
}

/**
 * `razorpay_checkout`: loads Standard Checkout (once), opens it for the
 * subscription and settles on the first of: the success handler (`completed`,
 * `result` is the handler response to POST to your server for
 * `verifyCheckout`), the customer closing the modal (`dismissed`) or
 * `payment.failed` (`failed`; the modal is closed so the outcome is final).
 *
 * With `callbackUrl` on the instruction Razorpay redirects the page itself
 * after authorisation and no handler is registered: the promise then only
 * settles for dismiss or failure, and otherwise the page navigates away.
 * `hostedUrl` is not used here; navigate to it with `redirectTo` instead.
 */
export async function openRazorpayCheckout(
  instruction: RazorpayCheckout,
  options?: OpenCheckoutOptions,
  env?: Partial<CheckoutEnv>,
): Promise<CheckoutOutcome> {
  const parsed = parseInput(RazorpayCheckoutSchema, instruction, `${CheckoutKind.RazorpayCheckout} checkout instruction`);
  const display = parseInput(OpenCheckoutOptionsSchema, options ?? {}, 'checkout options');
  const resolved = resolveEnv(env);

  let ctor = readGlobal(resolved.window, GlobalName.Razorpay);
  if (typeof ctor !== 'function') {
    await loadScript(ScriptUrl.RazorpayCheckout, resolved, Provider.Razorpay);
    ctor = readGlobal(resolved.window, GlobalName.Razorpay);
  }
  if (typeof ctor !== 'function') {
    throw new SubscriptionError(
      ErrorCode.ProviderUnavailable,
      'The Razorpay checkout script loaded but did not define Razorpay',
      { provider: Provider.Razorpay },
    );
  }
  const construct = ctor;

  return new Promise<CheckoutOutcome>((resolve, reject) => {
    let instance: unknown;
    const settle = (outcome: CheckoutOutcome): void => resolve(outcome);

    const razorpayOptions = buildRazorpayOptions(parsed, display, {
      onHandler: (response) => {
        try {
          const result = parseResponse(CheckoutResultSchema, response, 'checkout handler response', Provider.Razorpay);
          settle({ status: CheckoutStatus.Completed, result });
        } catch (error) {
          reject(error);
        }
      },
      onDismiss: () => settle({ status: CheckoutStatus.Dismissed }),
    });

    try {
      instance = Reflect.construct(construct, [razorpayOptions]);
      const on = method(instance, GatewayMethod.RazorpayOn);
      const open = method(instance, GatewayMethod.RazorpayOpen);
      if (!on || !open) {
        throw providerError('Razorpay checkout instance has no open/on methods');
      }
      on(RazorpayEvent.PaymentFailed, (response: unknown) => {
        const event = PaymentFailedEventSchema.safeParse(response);
        settle({ status: CheckoutStatus.Failed, error: (event.success ? event.data.error : undefined) ?? {} });
        // Settled first: closing fires ondismiss, which is then ignored.
        try {
          method(instance, GatewayMethod.RazorpayClose)?.();
        } catch {
          // The failure outcome is already delivered.
        }
      });
      open();
    } catch (error) {
      reject(error instanceof SubscriptionError ? error : providerError('Razorpay checkout could not be opened', error));
    }
  });
}
