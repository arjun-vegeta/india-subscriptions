import { z } from 'zod';
import { CheckoutResultSchema, MetadataSchema } from '../schemas.js';
import { CashfreeRedirectTarget, CheckoutStatus } from './constants.js';

/** Display options for the gateway's checkout UI. All optional. */
export const OpenCheckoutOptionsSchema = z.object({
  /** Business name shown in the Razorpay checkout header. */
  name: z.string().optional(),
  /** Line of text shown under the name (for example the plan). */
  description: z.string().optional(),
  /** Logo: an absolute URL or a path on your site. */
  image: z.string().optional(),
  theme: z.object({ color: z.string() }).optional(),
  /** Free-form notes echoed back by Razorpay. */
  notes: MetadataSchema.optional(),
  /** Cashfree only: where the hosted checkout opens. Defaults to a full-page redirect. */
  redirectTarget: z.enum(CashfreeRedirectTarget).optional(),
});
export type OpenCheckoutOptions = z.input<typeof OpenCheckoutOptionsSchema>;

/**
 * Error details a gateway reported. Razorpay's `payment.failed` carries
 * `code`, `description`, `source`, `step`, `reason`, `metadata`; Cashfree's
 * checkout returns `message`. Unknown fields are kept.
 */
export const CheckoutErrorSchema = z.looseObject({
  code: z.string().optional(),
  message: z.string().optional(),
  description: z.string().optional(),
  source: z.string().optional(),
  step: z.string().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CheckoutError = z.infer<typeof CheckoutErrorSchema>;

export const CheckoutOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal(CheckoutStatus.Redirecting) }),
  z.object({
    status: z.literal(CheckoutStatus.Completed),
    /** The gateway's handler response; POST it to your server and call `verifyCheckout`. */
    result: CheckoutResultSchema,
  }),
  z.object({ status: z.literal(CheckoutStatus.Dismissed) }),
  z.object({ status: z.literal(CheckoutStatus.Failed), error: CheckoutErrorSchema }),
]);
export type CheckoutOutcome = z.infer<typeof CheckoutOutcomeSchema>;
