/**
 * Constants for the browser checkout helper. Browser-safe: this file (and
 * everything under `src/checkout/`) must never import a `node:` module.
 */

/** What `openCheckout` reports back to the page. */
export const CheckoutStatus = {
  /** The browser is navigating away (redirect, form post) or the gateway took over the page; the result arrives server-side. */
  Redirecting: 'redirecting',
  /** The customer finished in-page; `result` is what to send to your server for verification. */
  Completed: 'completed',
  /** The customer closed the checkout without finishing. */
  Dismissed: 'dismissed',
  /** The gateway reported a failure; `error` carries its details. */
  Failed: 'failed',
} as const;
export type CheckoutStatus = (typeof CheckoutStatus)[keyof typeof CheckoutStatus];

/** Gateway-hosted scripts the helper loads on demand. */
export const ScriptUrl = {
  /** Razorpay Standard Checkout. [razorpay.md §6.2] */
  RazorpayCheckout: 'https://checkout.razorpay.com/v1/checkout.js',
  /**
   * cashfree.js v3. NOT stated in the fact sheet (§7.1: "not stated"); this is
   * Cashfree's published SDK location and must be confirmed in a real browser.
   */
  Cashfree: 'https://sdk.cashfree.com/js/v3/cashfree.js',
} as const;
export type ScriptUrl = (typeof ScriptUrl)[keyof typeof ScriptUrl];

/** Names the gateway scripts add to `window`. */
export const GlobalName = {
  Window: 'window',
  Document: 'document',
  Razorpay: 'Razorpay',
  Cashfree: 'Cashfree',
} as const;
export type GlobalName = (typeof GlobalName)[keyof typeof GlobalName];

/** Methods called on objects the gateway scripts create. */
export const GatewayMethod = {
  /** `rzp.open()`. [razorpay.md §6.2] */
  RazorpayOpen: 'open',
  /** `rzp.on('payment.failed', fn)`. */
  RazorpayOn: 'on',
  /** `rzp.close()`. */
  RazorpayClose: 'close',
  /** `cashfree.subscriptionsCheckout({...})`. [cashfree.md §7.1] */
  CashfreeSubscriptionsCheckout: 'subscriptionsCheckout',
} as const;
export type GatewayMethod = (typeof GatewayMethod)[keyof typeof GatewayMethod];

/** Event name for a failed Razorpay payment (`rzp.on(...)`). */
export const RazorpayEvent = {
  PaymentFailed: 'payment.failed',
} as const;
export type RazorpayEvent = (typeof RazorpayEvent)[keyof typeof RazorpayEvent];

/** Keys of the Razorpay Standard Checkout options object. [razorpay.md §6.2] */
export const RazorpayOption = {
  Key: 'key',
  SubscriptionId: 'subscription_id',
  Name: 'name',
  Description: 'description',
  Image: 'image',
  CallbackUrl: 'callback_url',
  Handler: 'handler',
  Prefill: 'prefill',
  Notes: 'notes',
  Theme: 'theme',
  Modal: 'modal',
} as const;
export type RazorpayOption = (typeof RazorpayOption)[keyof typeof RazorpayOption];

/** Keys inside Razorpay's `prefill` object. [razorpay.md §6.2] */
export const RazorpayPrefillKey = {
  Name: 'name',
  Email: 'email',
  Contact: 'contact',
} as const;
export type RazorpayPrefillKey = (typeof RazorpayPrefillKey)[keyof typeof RazorpayPrefillKey];

/** Keys inside Razorpay's `theme` object. [razorpay.md §6.2] */
export const RazorpayThemeKey = {
  Color: 'color',
} as const;
export type RazorpayThemeKey = (typeof RazorpayThemeKey)[keyof typeof RazorpayThemeKey];

/** Keys inside Razorpay's `modal` object. */
export const RazorpayModalKey = {
  OnDismiss: 'ondismiss',
} as const;
export type RazorpayModalKey = (typeof RazorpayModalKey)[keyof typeof RazorpayModalKey];

/** Cashfree.js constructor modes. [cashfree.md §7.1: `mode: "sandbox" // or production`] */
export const CashfreeMode = {
  Sandbox: 'sandbox',
  Production: 'production',
} as const;
export type CashfreeMode = (typeof CashfreeMode)[keyof typeof CashfreeMode];

/** Keys of the object passed to `Cashfree({...})`. */
export const CashfreeInitOption = {
  Mode: 'mode',
} as const;
export type CashfreeInitOption = (typeof CashfreeInitOption)[keyof typeof CashfreeInitOption];

/** Keys of the object passed to `subscriptionsCheckout({...})`. [cashfree.md §7.1] */
export const CashfreeCheckoutOption = {
  SubsSessionId: 'subsSessionId',
  RedirectTarget: 'redirectTarget',
} as const;
export type CashfreeCheckoutOption = (typeof CashfreeCheckoutOption)[keyof typeof CashfreeCheckoutOption];

/**
 * Where Cashfree opens the hosted checkout. The fact sheet shows only
 * `"_blank"` (§7.1: other values "not stated"); the rest are the standard
 * browsing-context names Cashfree.js accepts for its other checkouts.
 */
export const CashfreeRedirectTarget = {
  Self: '_self',
  Blank: '_blank',
  Top: '_top',
} as const;
export type CashfreeRedirectTarget = (typeof CashfreeRedirectTarget)[keyof typeof CashfreeRedirectTarget];

/** Default: a full-page redirect, so the customer returns to the merchant's `return_url` in the same tab. */
export const DEFAULT_CASHFREE_REDIRECT_TARGET = CashfreeRedirectTarget.Self;

/** DOM element tags the helper creates. */
export const DomTag = {
  Script: 'script',
  Form: 'form',
  Input: 'input',
} as const;
export type DomTag = (typeof DomTag)[keyof typeof DomTag];

/** DOM attribute names the helper sets. */
export const DomAttribute = {
  Src: 'src',
  Async: 'async',
  Method: 'method',
  Action: 'action',
  Type: 'type',
  Name: 'name',
  Value: 'value',
} as const;
export type DomAttribute = (typeof DomAttribute)[keyof typeof DomAttribute];

export const DomEvent = {
  Load: 'load',
  Error: 'error',
} as const;
export type DomEvent = (typeof DomEvent)[keyof typeof DomEvent];

export const InputType = {
  Hidden: 'hidden',
} as const;
export type InputType = (typeof InputType)[keyof typeof InputType];

export const FormMethod = {
  Post: 'POST',
} as const;
export type FormMethod = (typeof FormMethod)[keyof typeof FormMethod];

/** URL schemes the helper will navigate to, post to or load scripts from. */
export const ALLOWED_URL_PROTOCOLS: readonly string[] = ['https:', 'http:'];
