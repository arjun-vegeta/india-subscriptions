/**
 * Configuration of the self-hosted service (`india-subscriptions serve`): every
 * environment variable it reads, named once, and the Zod schemas that turn a
 * process environment into a validated `ServiceConfig`.
 *
 * Rules:
 * - A variable that is unset or blank counts as absent.
 * - A gateway is enabled when its required variables are all present. Setting
 *   only some of its variables (`RAZORPAY_KEY_ID` without `RAZORPAY_KEY_SECRET`)
 *   is an error, never a silently disabled gateway.
 * - Messages name the variable and the rule. They never contain a value, so a
 *   mistyped secret cannot end up in a log.
 */
import { z } from 'zod';
import { ErrorCode, Environment, Provider } from './constants.js';
import { SubscriptionError } from './errors.js';
import { CashfreeConfigSchema, type CashfreeConfig } from './providers/cashfree/schemas.js';
import { ConsentHashLayout } from './providers/payu/constants.js';
import { PayUConfigSchema, type PayUConfig } from './providers/payu/schemas.js';
import { PAYTM_DEBIT_REASON_MAX_LENGTH, PaytmChannelId } from './providers/paytm/constants.js';
import { PaytmConfigSchema, type PaytmConfig } from './providers/paytm/schemas.js';
import { PhonePeConfigSchema, type PhonePeConfig } from './providers/phonepe/schemas.js';
import { AppStoreConfigSchema, type AppStoreConfig } from './providers/appstore/schemas.js';
import { GooglePlayConfigSchema, type GooglePlayConfig } from './providers/googleplay/schemas.js';
import { DEFAULT_SCHEMA, DEFAULT_TABLE_PREFIX, MAX_IDENTIFIER_BYTES } from './postgres/constants.js';
import { resolveNames } from './postgres/names.js';
import { RAZORPAY_MAX_DURATION_YEARS } from './providers/razorpay/constants.js';
import { RazorpayConfigSchema, type RazorpayConfig } from './providers/razorpay/schemas.js';

/** Names of the environment variables the service reads. */
export const EnvVar = {
  ApiKey: 'INDIA_SUBSCRIPTIONS_API_KEY',
  Host: 'HOST',
  Port: 'PORT',

  RazorpayKeyId: 'RAZORPAY_KEY_ID',
  RazorpayKeySecret: 'RAZORPAY_KEY_SECRET',
  RazorpayWebhookSecret: 'RAZORPAY_WEBHOOK_SECRET',
  RazorpayDefaultDurationYears: 'RAZORPAY_DEFAULT_DURATION_YEARS',
  RazorpayBaseUrl: 'RAZORPAY_BASE_URL',

  CashfreeClientId: 'CASHFREE_CLIENT_ID',
  CashfreeClientSecret: 'CASHFREE_CLIENT_SECRET',
  CashfreeEnvironment: 'CASHFREE_ENVIRONMENT',
  CashfreeWebhookSecret: 'CASHFREE_WEBHOOK_SECRET',
  CashfreeApiVersion: 'CASHFREE_API_VERSION',
  CashfreeBaseUrl: 'CASHFREE_BASE_URL',

  PayuKey: 'PAYU_KEY',
  PayuSalt: 'PAYU_SALT',
  PayuEnvironment: 'PAYU_ENVIRONMENT',
  PayuSuccessUrl: 'PAYU_SUCCESS_URL',
  PayuFailureUrl: 'PAYU_FAILURE_URL',
  PayuConsentHashLayout: 'PAYU_CONSENT_HASH_LAYOUT',
  PayuAcceptUnsignedWebhooks: 'PAYU_ACCEPT_UNSIGNED_WEBHOOKS',
  PayuPaymentUrl: 'PAYU_PAYMENT_URL',
  PayuApiUrl: 'PAYU_API_URL',

  PhonepeClientId: 'PHONEPE_CLIENT_ID',
  PhonepeClientSecret: 'PHONEPE_CLIENT_SECRET',
  PhonepeClientVersion: 'PHONEPE_CLIENT_VERSION',
  PhonepeEnvironment: 'PHONEPE_ENVIRONMENT',
  PhonepeWebhookUsername: 'PHONEPE_WEBHOOK_USERNAME',
  PhonepeWebhookPassword: 'PHONEPE_WEBHOOK_PASSWORD',
  PhonepeRedirectUrl: 'PHONEPE_REDIRECT_URL',
  PhonepeApiUrl: 'PHONEPE_API_URL',
  PhonepeTokenUrl: 'PHONEPE_TOKEN_URL',

  PaytmMid: 'PAYTM_MID',
  PaytmMerchantKey: 'PAYTM_MERCHANT_KEY',
  PaytmWebsite: 'PAYTM_WEBSITE',
  PaytmEnvironment: 'PAYTM_ENVIRONMENT',
  PaytmCallbackUrl: 'PAYTM_CALLBACK_URL',
  PaytmChannelId: 'PAYTM_CHANNEL_ID',
  PaytmClientId: 'PAYTM_CLIENT_ID',
  PaytmGraceDays: 'PAYTM_GRACE_DAYS',
  PaytmRetryCount: 'PAYTM_RETRY_COUNT',
  PaytmMandateYears: 'PAYTM_MANDATE_YEARS',
  PaytmDebitReason: 'PAYTM_DEBIT_REASON',
  PaytmSubscriptionBaseUrl: 'PAYTM_SUBSCRIPTION_BASE_URL',
  PaytmTransactionStatusBaseUrl: 'PAYTM_TRANSACTION_STATUS_BASE_URL',
  PaytmRefundBaseUrl: 'PAYTM_REFUND_BASE_URL',
  PaytmCheckoutBaseUrl: 'PAYTM_CHECKOUT_BASE_URL',

  AppStoreBundleId: 'APP_STORE_BUNDLE_ID',
  AppStoreIssuerId: 'APP_STORE_ISSUER_ID',
  AppStoreKeyId: 'APP_STORE_KEY_ID',
  AppStorePrivateKey: 'APP_STORE_PRIVATE_KEY',
  AppStoreEnvironment: 'APP_STORE_ENVIRONMENT',
  AppStoreAppAppleId: 'APP_STORE_APP_APPLE_ID',
  AppStoreOfferKeyId: 'APP_STORE_OFFER_KEY_ID',
  AppStoreOfferPrivateKey: 'APP_STORE_OFFER_PRIVATE_KEY',

  GooglePlayPackageName: 'GOOGLE_PLAY_PACKAGE_NAME',
  GooglePlayClientEmail: 'GOOGLE_PLAY_CLIENT_EMAIL',
  GooglePlayPrivateKey: 'GOOGLE_PLAY_PRIVATE_KEY',
  GooglePlayPrivateKeyId: 'GOOGLE_PLAY_PRIVATE_KEY_ID',
  GooglePlayEnvironment: 'GOOGLE_PLAY_ENVIRONMENT',
  GooglePlayPushAudience: 'GOOGLE_PLAY_PUSH_AUDIENCE',
  GooglePlayPushServiceAccountEmail: 'GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL',
  GooglePlayAcceptUnauthenticatedWebhooks: 'GOOGLE_PLAY_ACCEPT_UNAUTHENTICATED_WEBHOOKS',
  GooglePlayRevokeOnRefund: 'GOOGLE_PLAY_REVOKE_ON_REFUND',
  GooglePlayConsumableProductIds: 'GOOGLE_PLAY_CONSUMABLE_PRODUCT_IDS',

  PublicBaseUrl: 'PUBLIC_BASE_URL',
  PurchasesFile: 'PURCHASES_FILE',
  PurchaseStoreFile: 'PURCHASE_STORE_FILE',

  SchedulerStoreFile: 'SCHEDULER_STORE_FILE',
  SchedulerTickSeconds: 'SCHEDULER_TICK_SECONDS',

  DatabaseUrl: 'DATABASE_URL',
  DatabaseSchema: 'DATABASE_SCHEMA',
  DatabaseTablePrefix: 'DATABASE_TABLE_PREFIX',
  DatabasePoolSize: 'DATABASE_POOL_SIZE',

  EventsWebhookUrl: 'EVENTS_WEBHOOK_URL',
  EventsWebhookSecret: 'EVENTS_WEBHOOK_SECRET',
} as const;
export type EnvVar = (typeof EnvVar)[keyof typeof EnvVar];

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_TICK_SECONDS = 300;
/** Connections one instance may hold open to the database unless `DATABASE_POOL_SIZE` says otherwise (the driver's own default). */
export const DEFAULT_DATABASE_POOL_SIZE = 10;
/** Most connections `DATABASE_POOL_SIZE` accepts. */
export const MAX_DATABASE_POOL_SIZE = 200;
/** Longest tick interval accepted: a day. */
export const MAX_TICK_SECONDS = 86_400;
/** Keys shorter than this still work but earn a warning. */
export const MIN_RECOMMENDED_API_KEY_LENGTH = 16;
const MAX_PORT = 65_535;
const LOOPBACK_HOSTS: readonly string[] = [DEFAULT_HOST, 'localhost', '::1'];
const WEBHOOK_PROTOCOLS: readonly string[] = ['http:', 'https:'];
const INSECURE_PROTOCOL = 'http:';
const WHOLE_NUMBER = /^\d+$/;
/** The URL schemes of a PostgreSQL connection string. */
const DATABASE_PROTOCOLS: readonly string[] = ['postgres:', 'postgresql:'];

/** Variables of each gateway. Any of them being set means the gateway is meant to be on. */
const GATEWAY_VARS: Record<EnvProvider, readonly EnvVar[]> = {
  [Provider.Razorpay]: [
    EnvVar.RazorpayKeyId,
    EnvVar.RazorpayKeySecret,
    EnvVar.RazorpayWebhookSecret,
    EnvVar.RazorpayDefaultDurationYears,
    EnvVar.RazorpayBaseUrl,
  ],
  [Provider.Cashfree]: [
    EnvVar.CashfreeClientId,
    EnvVar.CashfreeClientSecret,
    EnvVar.CashfreeEnvironment,
    EnvVar.CashfreeWebhookSecret,
    EnvVar.CashfreeApiVersion,
    EnvVar.CashfreeBaseUrl,
  ],
  [Provider.PayU]: [
    EnvVar.PayuKey,
    EnvVar.PayuSalt,
    EnvVar.PayuEnvironment,
    EnvVar.PayuSuccessUrl,
    EnvVar.PayuFailureUrl,
    EnvVar.PayuConsentHashLayout,
    EnvVar.PayuAcceptUnsignedWebhooks,
    EnvVar.PayuPaymentUrl,
    EnvVar.PayuApiUrl,
  ],
  [Provider.PhonePe]: [
    EnvVar.PhonepeClientId,
    EnvVar.PhonepeClientSecret,
    EnvVar.PhonepeClientVersion,
    EnvVar.PhonepeEnvironment,
    EnvVar.PhonepeWebhookUsername,
    EnvVar.PhonepeWebhookPassword,
    EnvVar.PhonepeRedirectUrl,
    EnvVar.PhonepeApiUrl,
    EnvVar.PhonepeTokenUrl,
  ],
  [Provider.Paytm]: [
    EnvVar.PaytmMid,
    EnvVar.PaytmMerchantKey,
    EnvVar.PaytmWebsite,
    EnvVar.PaytmEnvironment,
    EnvVar.PaytmCallbackUrl,
    EnvVar.PaytmChannelId,
    EnvVar.PaytmClientId,
    EnvVar.PaytmGraceDays,
    EnvVar.PaytmRetryCount,
    EnvVar.PaytmMandateYears,
    EnvVar.PaytmDebitReason,
    EnvVar.PaytmSubscriptionBaseUrl,
    EnvVar.PaytmTransactionStatusBaseUrl,
    EnvVar.PaytmRefundBaseUrl,
    EnvVar.PaytmCheckoutBaseUrl,
  ],
  [Provider.AppStore]: [
    EnvVar.AppStoreBundleId,
    EnvVar.AppStoreIssuerId,
    EnvVar.AppStoreKeyId,
    EnvVar.AppStorePrivateKey,
    EnvVar.AppStoreEnvironment,
    EnvVar.AppStoreAppAppleId,
    EnvVar.AppStoreOfferKeyId,
    EnvVar.AppStoreOfferPrivateKey,
  ],
  [Provider.GooglePlay]: [
    EnvVar.GooglePlayPackageName,
    EnvVar.GooglePlayClientEmail,
    EnvVar.GooglePlayPrivateKey,
    EnvVar.GooglePlayPrivateKeyId,
    EnvVar.GooglePlayEnvironment,
    EnvVar.GooglePlayPushAudience,
    EnvVar.GooglePlayPushServiceAccountEmail,
    EnvVar.GooglePlayAcceptUnauthenticatedWebhooks,
    EnvVar.GooglePlayRevokeOnRefund,
    EnvVar.GooglePlayConsumableProductIds,
  ],
};

/** The variables a gateway cannot work without. */
const GATEWAY_REQUIRED_VARS: Record<EnvProvider, readonly EnvVar[]> = {
  [Provider.Razorpay]: [EnvVar.RazorpayKeyId, EnvVar.RazorpayKeySecret],
  [Provider.Cashfree]: [EnvVar.CashfreeClientId, EnvVar.CashfreeClientSecret, EnvVar.CashfreeEnvironment],
  [Provider.PayU]: [EnvVar.PayuKey, EnvVar.PayuSalt, EnvVar.PayuEnvironment],
  [Provider.PhonePe]: [
    EnvVar.PhonepeClientId,
    EnvVar.PhonepeClientSecret,
    EnvVar.PhonepeClientVersion,
    EnvVar.PhonepeEnvironment,
  ],
  [Provider.Paytm]: [EnvVar.PaytmMid, EnvVar.PaytmMerchantKey, EnvVar.PaytmWebsite, EnvVar.PaytmEnvironment],
  [Provider.AppStore]: [
    EnvVar.AppStoreBundleId,
    EnvVar.AppStoreIssuerId,
    EnvVar.AppStoreKeyId,
    EnvVar.AppStorePrivateKey,
    EnvVar.AppStoreEnvironment,
  ],
  [Provider.GooglePlay]: [
    EnvVar.GooglePlayPackageName,
    EnvVar.GooglePlayClientEmail,
    EnvVar.GooglePlayPrivateKey,
    EnvVar.GooglePlayEnvironment,
  ],
};

/** Which variable feeds which field of each adapter's config, to name the variable when the adapter's schema objects. */
const CONFIG_FIELD_VARS: Record<EnvProvider, Record<string, EnvVar>> = {
  [Provider.Razorpay]: {
    keyId: EnvVar.RazorpayKeyId,
    keySecret: EnvVar.RazorpayKeySecret,
    webhookSecret: EnvVar.RazorpayWebhookSecret,
    baseUrl: EnvVar.RazorpayBaseUrl,
    defaultDurationYears: EnvVar.RazorpayDefaultDurationYears,
  },
  [Provider.Cashfree]: {
    clientId: EnvVar.CashfreeClientId,
    clientSecret: EnvVar.CashfreeClientSecret,
    environment: EnvVar.CashfreeEnvironment,
    webhookSecret: EnvVar.CashfreeWebhookSecret,
    apiVersion: EnvVar.CashfreeApiVersion,
    baseUrl: EnvVar.CashfreeBaseUrl,
  },
  [Provider.PayU]: {
    key: EnvVar.PayuKey,
    salt: EnvVar.PayuSalt,
    environment: EnvVar.PayuEnvironment,
    successUrl: EnvVar.PayuSuccessUrl,
    failureUrl: EnvVar.PayuFailureUrl,
    consentHashLayout: EnvVar.PayuConsentHashLayout,
    acceptUnsignedWebhooks: EnvVar.PayuAcceptUnsignedWebhooks,
    paymentUrl: EnvVar.PayuPaymentUrl,
    apiUrl: EnvVar.PayuApiUrl,
  },
  [Provider.PhonePe]: {
    clientId: EnvVar.PhonepeClientId,
    clientSecret: EnvVar.PhonepeClientSecret,
    clientVersion: EnvVar.PhonepeClientVersion,
    environment: EnvVar.PhonepeEnvironment,
    webhookUsername: EnvVar.PhonepeWebhookUsername,
    webhookPassword: EnvVar.PhonepeWebhookPassword,
    redirectUrl: EnvVar.PhonepeRedirectUrl,
    apiUrl: EnvVar.PhonepeApiUrl,
    tokenUrl: EnvVar.PhonepeTokenUrl,
  },
  [Provider.Paytm]: {
    mid: EnvVar.PaytmMid,
    merchantKey: EnvVar.PaytmMerchantKey,
    website: EnvVar.PaytmWebsite,
    environment: EnvVar.PaytmEnvironment,
    callbackUrl: EnvVar.PaytmCallbackUrl,
    channelId: EnvVar.PaytmChannelId,
    clientId: EnvVar.PaytmClientId,
    graceDays: EnvVar.PaytmGraceDays,
    retryCount: EnvVar.PaytmRetryCount,
    mandateYears: EnvVar.PaytmMandateYears,
    debitReason: EnvVar.PaytmDebitReason,
    subscriptionBaseUrl: EnvVar.PaytmSubscriptionBaseUrl,
    transactionStatusBaseUrl: EnvVar.PaytmTransactionStatusBaseUrl,
    refundBaseUrl: EnvVar.PaytmRefundBaseUrl,
    checkoutBaseUrl: EnvVar.PaytmCheckoutBaseUrl,
  },
  [Provider.AppStore]: {
    bundleId: EnvVar.AppStoreBundleId,
    issuerId: EnvVar.AppStoreIssuerId,
    keyId: EnvVar.AppStoreKeyId,
    privateKey: EnvVar.AppStorePrivateKey,
    environment: EnvVar.AppStoreEnvironment,
    appAppleId: EnvVar.AppStoreAppAppleId,
    promotionalOfferKey: EnvVar.AppStoreOfferPrivateKey,
  },
  [Provider.GooglePlay]: {
    packageName: EnvVar.GooglePlayPackageName,
    clientEmail: EnvVar.GooglePlayClientEmail,
    privateKey: EnvVar.GooglePlayPrivateKey,
    privateKeyId: EnvVar.GooglePlayPrivateKeyId,
    environment: EnvVar.GooglePlayEnvironment,
    pushAudience: EnvVar.GooglePlayPushAudience,
    pushServiceAccountEmail: EnvVar.GooglePlayPushServiceAccountEmail,
    acceptUnauthenticatedWebhooks: EnvVar.GooglePlayAcceptUnauthenticatedWebhooks,
    revokeOnRefund: EnvVar.GooglePlayRevokeOnRefund,
    consumableProductIds: EnvVar.GooglePlayConsumableProductIds,
  },
};

// ---------------------------------------------------------------------------
// Field schemas (every environment value is a string)
// ---------------------------------------------------------------------------

const REQUIRED_MESSAGE = 'is required';

function required(): z.ZodString {
  return z.string({ error: (issue) => (issue.input === undefined ? REQUIRED_MESSAGE : 'must be text') });
}

function wholeNumber(min: number, max: number): z.ZodType<number, string> {
  return z
    .string()
    .regex(WHOLE_NUMBER, { error: 'must be a whole number' })
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(min, { error: `must be at least ${min}` })
        .max(max, { error: `must be at most ${max}` }),
    );
}

/** False for anything that does not parse as a URL too: refinements still run after `z.url` has failed. */
function hasWebhookProtocol(value: string): boolean {
  try {
    return WEBHOOK_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** False for anything that does not parse as a URL. The value never reaches a message. */
function hasDatabaseProtocol(value: string): boolean {
  try {
    return DATABASE_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Whether `resolveNames` accepts the schema name and the table prefix, one at a time so the message can name the variable. */
function isValidIdentifier(option: 'schema' | 'tablePrefix', value: string): boolean {
  try {
    resolveNames({ [option]: value });
    return true;
  } catch {
    return false;
  }
}

const urlText = z.url({ error: 'must be a valid URL' });
const environmentText = z.enum(Environment, {
  error: (issue) => (issue.input === undefined ? REQUIRED_MESSAGE : 'must be "test" or "live"'),
});
const flag = z.stringbool({ error: 'must be "true" or "false"' });

const IDENTIFIER_MESSAGE = `must be at most ${MAX_IDENTIFIER_BYTES} characters of letters, digits and underscores, not starting with a digit`;

const ServiceEnvSchema = z.object({
  [EnvVar.ApiKey]: z.string().optional(),
  [EnvVar.Host]: z.string().optional(),
  [EnvVar.Port]: wholeNumber(0, MAX_PORT).optional(),
  [EnvVar.PublicBaseUrl]: urlText.refine(hasWebhookProtocol, { error: 'must be an http or https URL' }).optional(),
  [EnvVar.PurchasesFile]: z.string().optional(),
  [EnvVar.PurchaseStoreFile]: z.string().optional(),
  [EnvVar.SchedulerStoreFile]: z.string().optional(),
  [EnvVar.SchedulerTickSeconds]: wholeNumber(1, MAX_TICK_SECONDS).optional(),
  [EnvVar.DatabaseUrl]: z
    .string()
    .refine(hasDatabaseProtocol, { error: 'must be a postgres:// or postgresql:// connection string' })
    .optional(),
  [EnvVar.DatabaseSchema]: z
    .string()
    .refine((value) => isValidIdentifier('schema', value), { error: IDENTIFIER_MESSAGE })
    .optional(),
  [EnvVar.DatabaseTablePrefix]: z
    .string()
    .refine((value) => isValidIdentifier('tablePrefix', value), {
      error: `${IDENTIFIER_MESSAGE}, and short enough that every table and index name stays within ${MAX_IDENTIFIER_BYTES} characters`,
    })
    .optional(),
  [EnvVar.DatabasePoolSize]: wholeNumber(1, MAX_DATABASE_POOL_SIZE).optional(),
  [EnvVar.EventsWebhookUrl]: urlText
    .refine(hasWebhookProtocol, { error: 'must be an http or https URL' })
    .optional(),
  [EnvVar.EventsWebhookSecret]: z.string().optional(),
});

const RazorpayEnvSchema = z
  .object({
    [EnvVar.RazorpayKeyId]: required(),
    [EnvVar.RazorpayKeySecret]: required(),
    [EnvVar.RazorpayWebhookSecret]: z.string().optional(),
    [EnvVar.RazorpayDefaultDurationYears]: wholeNumber(1, RAZORPAY_MAX_DURATION_YEARS).optional(),
    [EnvVar.RazorpayBaseUrl]: urlText.optional(),
  })
  .transform(
    (env): RazorpayConfig => ({
      keyId: env[EnvVar.RazorpayKeyId],
      keySecret: env[EnvVar.RazorpayKeySecret],
      webhookSecret: env[EnvVar.RazorpayWebhookSecret],
      defaultDurationYears: env[EnvVar.RazorpayDefaultDurationYears],
      baseUrl: env[EnvVar.RazorpayBaseUrl],
    }),
  );

const CashfreeEnvSchema = z
  .object({
    [EnvVar.CashfreeClientId]: required(),
    [EnvVar.CashfreeClientSecret]: required(),
    [EnvVar.CashfreeEnvironment]: environmentText,
    [EnvVar.CashfreeWebhookSecret]: z.string().optional(),
    [EnvVar.CashfreeApiVersion]: z.string().optional(),
    [EnvVar.CashfreeBaseUrl]: urlText.optional(),
  })
  .transform(
    (env): CashfreeConfig => ({
      clientId: env[EnvVar.CashfreeClientId],
      clientSecret: env[EnvVar.CashfreeClientSecret],
      environment: env[EnvVar.CashfreeEnvironment],
      webhookSecret: env[EnvVar.CashfreeWebhookSecret],
      apiVersion: env[EnvVar.CashfreeApiVersion],
      baseUrl: env[EnvVar.CashfreeBaseUrl],
    }),
  );

const PayuEnvSchema = z
  .object({
    [EnvVar.PayuKey]: required(),
    [EnvVar.PayuSalt]: required(),
    [EnvVar.PayuEnvironment]: environmentText,
    [EnvVar.PayuSuccessUrl]: urlText.optional(),
    [EnvVar.PayuFailureUrl]: urlText.optional(),
    [EnvVar.PayuConsentHashLayout]: z
      .enum(ConsentHashLayout, { error: `must be one of ${Object.values(ConsentHashLayout).join(', ')}` })
      .optional(),
    [EnvVar.PayuAcceptUnsignedWebhooks]: flag.optional(),
    [EnvVar.PayuPaymentUrl]: urlText.optional(),
    [EnvVar.PayuApiUrl]: urlText.optional(),
  })
  .transform(
    (env): PayUConfig => ({
      key: env[EnvVar.PayuKey],
      salt: env[EnvVar.PayuSalt],
      environment: env[EnvVar.PayuEnvironment],
      successUrl: env[EnvVar.PayuSuccessUrl],
      failureUrl: env[EnvVar.PayuFailureUrl],
      consentHashLayout: env[EnvVar.PayuConsentHashLayout],
      acceptUnsignedWebhooks: env[EnvVar.PayuAcceptUnsignedWebhooks],
      paymentUrl: env[EnvVar.PayuPaymentUrl],
      apiUrl: env[EnvVar.PayuApiUrl],
    }),
  );

/** The webhook username and password go together: one without the other is a half-configured webhook. */
function requireTogether(
  env: Readonly<Record<string, unknown>>,
  first: EnvVar,
  second: EnvVar,
  context: z.RefinementCtx,
): void {
  for (const [present, missing] of [[first, second], [second, first]] as const) {
    if (env[present] !== undefined && env[missing] === undefined) {
      context.addIssue({ code: 'custom', path: [missing], message: `is required when ${present} is set` });
    }
  }
}

const PhonepeEnvSchema = z
  .object({
    [EnvVar.PhonepeClientId]: required(),
    [EnvVar.PhonepeClientSecret]: required(),
    [EnvVar.PhonepeClientVersion]: required(),
    [EnvVar.PhonepeEnvironment]: environmentText,
    [EnvVar.PhonepeWebhookUsername]: z.string().optional(),
    [EnvVar.PhonepeWebhookPassword]: z.string().optional(),
    [EnvVar.PhonepeRedirectUrl]: urlText.optional(),
    [EnvVar.PhonepeApiUrl]: urlText.optional(),
    [EnvVar.PhonepeTokenUrl]: urlText.optional(),
  })
  .superRefine((env, context) => requireTogether(env, EnvVar.PhonepeWebhookUsername, EnvVar.PhonepeWebhookPassword, context))
  .transform(
    (env): PhonePeConfig => ({
      clientId: env[EnvVar.PhonepeClientId],
      clientSecret: env[EnvVar.PhonepeClientSecret],
      clientVersion: env[EnvVar.PhonepeClientVersion],
      environment: env[EnvVar.PhonepeEnvironment],
      webhookUsername: env[EnvVar.PhonepeWebhookUsername],
      webhookPassword: env[EnvVar.PhonepeWebhookPassword],
      redirectUrl: env[EnvVar.PhonepeRedirectUrl],
      apiUrl: env[EnvVar.PhonepeApiUrl],
      tokenUrl: env[EnvVar.PhonepeTokenUrl],
    }),
  );

const PaytmEnvSchema = z
  .object({
    [EnvVar.PaytmMid]: required(),
    [EnvVar.PaytmMerchantKey]: required(),
    [EnvVar.PaytmWebsite]: required(),
    [EnvVar.PaytmEnvironment]: environmentText,
    [EnvVar.PaytmCallbackUrl]: urlText.optional(),
    [EnvVar.PaytmChannelId]: z
      .enum(PaytmChannelId, { error: `must be one of ${Object.values(PaytmChannelId).join(', ')}` })
      .optional(),
    [EnvVar.PaytmClientId]: z.string().optional(),
    [EnvVar.PaytmGraceDays]: wholeNumber(0, 365).optional(),
    [EnvVar.PaytmRetryCount]: wholeNumber(1, 10).optional(),
    [EnvVar.PaytmMandateYears]: wholeNumber(1, 30).optional(),
    [EnvVar.PaytmDebitReason]: z
      .string()
      .max(PAYTM_DEBIT_REASON_MAX_LENGTH, { error: `must be at most ${PAYTM_DEBIT_REASON_MAX_LENGTH} characters` })
      .optional(),
    [EnvVar.PaytmSubscriptionBaseUrl]: urlText.optional(),
    [EnvVar.PaytmTransactionStatusBaseUrl]: urlText.optional(),
    [EnvVar.PaytmRefundBaseUrl]: urlText.optional(),
    [EnvVar.PaytmCheckoutBaseUrl]: urlText.optional(),
  })
  .transform(
    (env): PaytmConfig => ({
      mid: env[EnvVar.PaytmMid],
      merchantKey: env[EnvVar.PaytmMerchantKey],
      website: env[EnvVar.PaytmWebsite],
      environment: env[EnvVar.PaytmEnvironment],
      callbackUrl: env[EnvVar.PaytmCallbackUrl],
      channelId: env[EnvVar.PaytmChannelId],
      clientId: env[EnvVar.PaytmClientId],
      graceDays: env[EnvVar.PaytmGraceDays],
      retryCount: env[EnvVar.PaytmRetryCount],
      mandateYears: env[EnvVar.PaytmMandateYears],
      debitReason: env[EnvVar.PaytmDebitReason],
      subscriptionBaseUrl: env[EnvVar.PaytmSubscriptionBaseUrl],
      transactionStatusBaseUrl: env[EnvVar.PaytmTransactionStatusBaseUrl],
      refundBaseUrl: env[EnvVar.PaytmRefundBaseUrl],
      checkoutBaseUrl: env[EnvVar.PaytmCheckoutBaseUrl],
    }),
  );

/** A PEM in one line of an environment file carries `\n` for each line break: put the real line breaks back. */
function unescapeNewlines(value: string): string {
  return value.replace(/\\n/g, '\n');
}

/** A comma-separated list: entries trimmed, blanks dropped. */
function commaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function commaListOrUndefined(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : commaList(value);
}

const AppStoreEnvSchema = z
  .object({
    [EnvVar.AppStoreBundleId]: required(),
    [EnvVar.AppStoreIssuerId]: required(),
    [EnvVar.AppStoreKeyId]: required(),
    [EnvVar.AppStorePrivateKey]: required(),
    [EnvVar.AppStoreEnvironment]: environmentText,
    [EnvVar.AppStoreAppAppleId]: wholeNumber(1, Number.MAX_SAFE_INTEGER).optional(),
    [EnvVar.AppStoreOfferKeyId]: z.string().optional(),
    [EnvVar.AppStoreOfferPrivateKey]: z.string().optional(),
  })
  .superRefine((env, context) => requireTogether(env, EnvVar.AppStoreOfferKeyId, EnvVar.AppStoreOfferPrivateKey, context))
  .transform((env): AppStoreConfig => {
    const offerKeyId = env[EnvVar.AppStoreOfferKeyId];
    const offerPrivateKey = env[EnvVar.AppStoreOfferPrivateKey];
    return {
      bundleId: env[EnvVar.AppStoreBundleId],
      issuerId: env[EnvVar.AppStoreIssuerId],
      keyId: env[EnvVar.AppStoreKeyId],
      privateKey: unescapeNewlines(env[EnvVar.AppStorePrivateKey]),
      environment: env[EnvVar.AppStoreEnvironment],
      appAppleId: env[EnvVar.AppStoreAppAppleId],
      promotionalOfferKey:
        offerKeyId !== undefined && offerPrivateKey !== undefined
          ? { keyId: offerKeyId, privateKey: unescapeNewlines(offerPrivateKey) }
          : undefined,
    };
  });

const GooglePlayEnvSchema = z
  .object({
    [EnvVar.GooglePlayPackageName]: required(),
    [EnvVar.GooglePlayClientEmail]: required(),
    [EnvVar.GooglePlayPrivateKey]: required(),
    [EnvVar.GooglePlayPrivateKeyId]: z.string().optional(),
    [EnvVar.GooglePlayEnvironment]: environmentText,
    [EnvVar.GooglePlayPushAudience]: z.string().optional(),
    [EnvVar.GooglePlayPushServiceAccountEmail]: z.string().optional(),
    [EnvVar.GooglePlayAcceptUnauthenticatedWebhooks]: flag.optional(),
    [EnvVar.GooglePlayRevokeOnRefund]: flag.optional(),
    [EnvVar.GooglePlayConsumableProductIds]: z.string().optional(),
  })
  .superRefine((env, context) =>
    requireTogether(env, EnvVar.GooglePlayPushAudience, EnvVar.GooglePlayPushServiceAccountEmail, context),
  )
  .transform(
    (env): GooglePlayConfig => ({
      packageName: env[EnvVar.GooglePlayPackageName],
      clientEmail: env[EnvVar.GooglePlayClientEmail],
      privateKey: unescapeNewlines(env[EnvVar.GooglePlayPrivateKey]),
      privateKeyId: env[EnvVar.GooglePlayPrivateKeyId],
      environment: env[EnvVar.GooglePlayEnvironment],
      pushAudience: env[EnvVar.GooglePlayPushAudience],
      pushServiceAccountEmail: env[EnvVar.GooglePlayPushServiceAccountEmail],
      acceptUnauthenticatedWebhooks: env[EnvVar.GooglePlayAcceptUnauthenticatedWebhooks],
      revokeOnRefund: env[EnvVar.GooglePlayRevokeOnRefund],
      consumableProductIds: commaListOrUndefined(env[EnvVar.GooglePlayConsumableProductIds]),
    }),
  );

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface EventsWebhookConfig {
  url: string;
  secret: string;
}

/** The PostgreSQL settings of the service. */
export interface DatabaseConfig {
  /** The connection string. A secret. */
  url: string;
  /** The schema that holds the tables. Default `public`. */
  schema: string;
  /** Prepended to every table and index name. */
  tablePrefix: string;
  /** Connections this instance may hold open. */
  poolSize: number;
}

/** Whether the billing scheduler runs: a store file or a database is configured. */
export function schedulerEnabled(config: Pick<ServiceConfig, 'schedulerStoreFile' | 'database'>): boolean {
  return config.schedulerStoreFile !== undefined || config.database !== undefined;
}

/** Validated configuration. It holds secrets: never log it. */
export interface ServiceConfig {
  host: string;
  port: number;
  /** Clients must send this as a bearer token. Absent only with `allowUnauthenticated`. */
  apiKey?: string;
  allowUnauthenticated: boolean;
  gateways: {
    [Provider.Razorpay]?: RazorpayConfig;
    [Provider.Cashfree]?: CashfreeConfig;
    [Provider.PayU]?: PayUConfig;
    [Provider.PhonePe]?: PhonePeConfig;
    [Provider.Paytm]?: PaytmConfig;
  };
  /** The app stores, each present when its variables are set. */
  stores: {
    [Provider.AppStore]?: AppStoreConfig;
    [Provider.GooglePlay]?: GooglePlayConfig;
  };
  /** The service's public URL without a trailing slash, as customers' browsers reach it. The hosted checkout and the gateways' return URLs are built on it. */
  publicBaseUrl?: string;
  /** Path of the purchases configuration (`{ catalog, policy?, routing? }`). Absent: the purchase routes answer with a configuration error. */
  purchasesFile?: string;
  /** Path of the `FilePurchaseStore`. Set together with `purchasesFile`, and never together with `database`. */
  purchaseStoreFile?: string;
  /** Path of the scheduler's `FileSchedulerStore`. Absent (and no `database`): the billing scheduler is off. */
  schedulerStoreFile?: string;
  /**
   * PostgreSQL for the scheduler, the purchase module and the routing statistics. Holds the connection string, which is
   * a secret: never log it. Excludes `schedulerStoreFile` and `purchaseStoreFile`.
   */
  database?: DatabaseConfig;
  tickSeconds: number;
  eventsWebhook?: EventsWebhookConfig;
  /** Things worth saying at startup that are not errors. Free of secrets. */
  warnings: string[];
}

export interface ParseServiceEnvOptions {
  /** The `--allow-unauthenticated` flag: serve the protected routes without an API key. */
  allowUnauthenticated?: boolean;
}

export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/**
 * The gateways `serve` can configure from environment variables, in the order
 * they are tried and listed. A gateway added to `Provider` joins this list once
 * its variables are defined below.
 */
export const GATEWAY_ORDER = [
  Provider.Razorpay,
  Provider.Cashfree,
  Provider.PayU,
  Provider.PhonePe,
  Provider.Paytm,
] as const;
/** A gateway that can be configured from environment variables. */
export type EnvGateway = (typeof GATEWAY_ORDER)[number];

/** The app stores `serve` can configure from environment variables, in the order they are tried and listed. */
export const STORE_ORDER = [Provider.AppStore, Provider.GooglePlay] as const;
/** An app store that can be configured from environment variables. */
export type EnvStore = (typeof STORE_ORDER)[number];

/** Every provider `serve` can configure: the gateways, then the stores. */
export const PROVIDER_ORDER = [...GATEWAY_ORDER, ...STORE_ORDER] as const;
export type EnvProvider = EnvGateway | EnvStore;

const GATEWAY_ENV_SCHEMAS = {
  [Provider.Razorpay]: { env: RazorpayEnvSchema, config: RazorpayConfigSchema },
  [Provider.Cashfree]: { env: CashfreeEnvSchema, config: CashfreeConfigSchema },
  [Provider.PayU]: { env: PayuEnvSchema, config: PayUConfigSchema },
  [Provider.PhonePe]: { env: PhonepeEnvSchema, config: PhonePeConfigSchema },
  [Provider.Paytm]: { env: PaytmEnvSchema, config: PaytmConfigSchema },
  [Provider.AppStore]: { env: AppStoreEnvSchema, config: AppStoreConfigSchema },
  [Provider.GooglePlay]: { env: GooglePlayEnvSchema, config: GooglePlayConfigSchema },
} as const;

type Values = Record<string, string>;

/** Present, trimmed, non-blank values only. */
function presentValues(env: EnvironmentVariables): Values {
  const values: Values = {};
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (value) values[name] = value;
  }
  return values;
}

function describeIssues(error: z.ZodError, nameOf: (path: PropertyKey[]) => string): string[] {
  return error.issues.map((issue) => `${nameOf(issue.path)}: ${issue.message}`);
}

function variableName(path: PropertyKey[]): string {
  return path.length > 0 ? String(path[0]) : '(environment)';
}

function describeGatewayVars(provider: EnvProvider): string {
  return `${provider} (${GATEWAY_REQUIRED_VARS[provider].join(', ')})`;
}

/**
 * Validates a process environment into a `ServiceConfig`. Throws one
 * `SubscriptionError` (`CONFIG`) that lists every problem found, so a
 * misconfigured deployment is fixed in one pass.
 */
export function parseServiceEnv(env: EnvironmentVariables, options: ParseServiceEnvOptions = {}): ServiceConfig {
  const values = presentValues(env);
  const problems: string[] = [];
  const warnings: string[] = [];

  const service = ServiceEnvSchema.safeParse(values);
  if (!service.success) problems.push(...describeIssues(service.error, variableName));
  const base = service.success ? service.data : undefined;

  // Authentication.
  const apiKey = base?.[EnvVar.ApiKey];
  const allowUnauthenticated = options.allowUnauthenticated === true;
  if (!apiKey && !allowUnauthenticated) {
    problems.push(
      `${EnvVar.ApiKey}: is required. It protects an API that holds your live gateway credentials; set a long random ` +
        'value, or pass --allow-unauthenticated to serve without one (only behind something that authenticates for you).',
    );
  } else if (apiKey && allowUnauthenticated) {
    warnings.push(`--allow-unauthenticated is ignored because ${EnvVar.ApiKey} is set: clients must send the key.`);
  } else if (!apiKey) {
    warnings.push('Running WITHOUT an API key: anyone who can reach this port can move money through your gateway accounts.');
  }
  if (apiKey && apiKey.length < MIN_RECOMMENDED_API_KEY_LENGTH) {
    warnings.push(`${EnvVar.ApiKey} is shorter than ${MIN_RECOMMENDED_API_KEY_LENGTH} characters: use a long random value.`);
  }

  // Events webhook: both or neither.
  const eventsUrl = base?.[EnvVar.EventsWebhookUrl];
  const eventsSecret = base?.[EnvVar.EventsWebhookSecret];
  let eventsWebhook: EventsWebhookConfig | undefined;
  if (service.success && (values[EnvVar.EventsWebhookUrl] || eventsSecret)) {
    if (!values[EnvVar.EventsWebhookUrl]) problems.push(`${EnvVar.EventsWebhookUrl}: is required when ${EnvVar.EventsWebhookSecret} is set`);
    else if (!eventsSecret) problems.push(`${EnvVar.EventsWebhookSecret}: is required when ${EnvVar.EventsWebhookUrl} is set`);
    else if (eventsUrl) eventsWebhook = { url: eventsUrl, secret: eventsSecret };
  }
  if (eventsWebhook && new URL(eventsWebhook.url).protocol === INSECURE_PROTOCOL) {
    warnings.push(`${EnvVar.EventsWebhookUrl} is plain http: events travel unencrypted (they are signed, not secret-free).`);
  }

  // Gateways and app stores.
  const gateways: ServiceConfig['gateways'] = {};
  const stores: ServiceConfig['stores'] = {};
  let anyProviderVariable = false;
  for (const provider of PROVIDER_ORDER) {
    const present = GATEWAY_VARS[provider].filter((name) => values[name] !== undefined);
    if (present.length === 0) continue;
    anyProviderVariable = true;
    const { env: envSchema, config: configSchema } = GATEWAY_ENV_SCHEMAS[provider];
    const fromEnv = envSchema.safeParse(values);
    if (!fromEnv.success) {
      const issues = describeIssues(fromEnv.error, variableName);
      problems.push(
        ...issues.map((issue) =>
          issue.endsWith(REQUIRED_MESSAGE) ? `${issue} (${present[0]} is set, so ${provider} must be fully configured)` : issue,
        ),
      );
      continue;
    }
    // The adapter's own schema has the last word (URL shapes, API version format, ...).
    const checked = configSchema.safeParse(fromEnv.data);
    if (!checked.success) {
      const fields = CONFIG_FIELD_VARS[provider];
      problems.push(
        ...describeIssues(checked.error, (path) => fields[String(path[0])] ?? provider),
      );
      continue;
    }
    ((STORE_ORDER as readonly Provider[]).includes(provider) ? (stores as Record<string, unknown>) : (gateways as Record<string, unknown>))[
      provider
    ] = fromEnv.data;
  }

  if (!anyProviderVariable) {
    problems.push(
      'No payment gateway or app store is configured. Set the variables of at least one: ' +
        PROVIDER_ORDER.map((provider) => describeGatewayVars(provider)).join('; '),
    );
  }

  // The database: the connection string, and the settings that only mean something with it.
  const databaseUrl = base?.[EnvVar.DatabaseUrl];
  const databaseSettings = [EnvVar.DatabaseSchema, EnvVar.DatabaseTablePrefix, EnvVar.DatabasePoolSize] as const;
  if (values[EnvVar.DatabaseUrl] === undefined) {
    for (const name of databaseSettings) {
      if (values[name] !== undefined) problems.push(`${EnvVar.DatabaseUrl}: is required when ${name} is set`);
    }
  }

  // Purchases: the configuration file and its durable store go together; the public URL is what the hosted checkout is built on.
  // The durable store is a file, or the database.
  const purchasesFile = values[EnvVar.PurchasesFile];
  const purchaseStoreFile = values[EnvVar.PurchaseStoreFile];
  const schedulerStoreFile = values[EnvVar.SchedulerStoreFile];
  const hasDatabase = values[EnvVar.DatabaseUrl] !== undefined;
  if (hasDatabase) {
    for (const [name, file] of [
      [EnvVar.SchedulerStoreFile, schedulerStoreFile],
      [EnvVar.PurchaseStoreFile, purchaseStoreFile],
    ] as const) {
      if (file) {
        problems.push(
          `${EnvVar.DatabaseUrl} and ${name} cannot both be set: the state is kept in the database or in a file, not both. Unset ${name} to use the database, or ${EnvVar.DatabaseUrl} to keep the file`,
        );
      }
    }
  }
  if (purchasesFile && !purchaseStoreFile && !hasDatabase) {
    problems.push(
      `${EnvVar.PurchaseStoreFile}: is required when ${EnvVar.PurchasesFile} is set (sessions, entitlements and the report queue must survive a restart; set ${EnvVar.DatabaseUrl} to keep them in PostgreSQL)`,
    );
  } else if (purchaseStoreFile && !purchasesFile) {
    problems.push(`${EnvVar.PurchasesFile}: is required when ${EnvVar.PurchaseStoreFile} is set`);
  }
  const publicBaseUrl = base?.[EnvVar.PublicBaseUrl]?.replace(/\/+$/, '');
  if (purchasesFile && (purchaseStoreFile || hasDatabase)) {
    if (!publicBaseUrl) {
      warnings.push(
        `${EnvVar.PublicBaseUrl} is not set: purchase options carry no hostedUrl and gateways return customers to the returnUrl of the purchase, so the hosted checkout is not offered.`,
      );
    } else if (new URL(publicBaseUrl).protocol === INSECURE_PROTOCOL && !LOOPBACK_HOSTS.includes(new URL(publicBaseUrl).hostname)) {
      warnings.push(`${EnvVar.PublicBaseUrl} is plain http: customers are sent to the hosted checkout over an unencrypted connection.`);
    }
  }

  const { razorpay, cashfree, payu, phonepe } = {
    razorpay: gateways[Provider.Razorpay],
    cashfree: gateways[Provider.Cashfree],
    payu: gateways[Provider.PayU],
    phonepe: gateways[Provider.PhonePe],
  };
  if (razorpay && !razorpay.webhookSecret) {
    warnings.push(`${EnvVar.RazorpayWebhookSecret} is not set: webhooks from razorpay will be rejected.`);
  }
  if (cashfree && !cashfree.webhookSecret) {
    warnings.push(`${EnvVar.CashfreeWebhookSecret} is not set: webhooks from cashfree are verified with ${EnvVar.CashfreeClientSecret}.`);
  }
  if (payu && !payu.successUrl) {
    warnings.push(`${EnvVar.PayuSuccessUrl} is not set: every payu subscription must carry its own returnUrl.`);
  }

  const googlePlayConfig = stores[Provider.GooglePlay];
  if (googlePlayConfig && !googlePlayConfig.pushAudience && !googlePlayConfig.acceptUnauthenticatedWebhooks) {
    warnings.push(
      `${EnvVar.GooglePlayPushAudience} and ${EnvVar.GooglePlayPushServiceAccountEmail} are not set: webhooks from google_play will be rejected.`,
    );
  }

  if (phonepe && !phonepe.webhookUsername) {
    warnings.push(
      `${EnvVar.PhonepeWebhookUsername} and ${EnvVar.PhonepeWebhookPassword} are not set: webhooks from phonepe will be rejected.`,
    );
  }

  const host = base?.[EnvVar.Host] ?? DEFAULT_HOST;
  if (allowUnauthenticated && !apiKey && !LOOPBACK_HOSTS.includes(host)) {
    warnings.push(`Listening on ${host} without an API key exposes the service to the network.`);
  }

  if (problems.length > 0) {
    throw new SubscriptionError(
      ErrorCode.Config,
      `Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }

  return {
    host,
    port: base?.[EnvVar.Port] ?? DEFAULT_PORT,
    apiKey,
    allowUnauthenticated: !apiKey && allowUnauthenticated,
    gateways,
    stores,
    publicBaseUrl,
    purchasesFile,
    purchaseStoreFile,
    schedulerStoreFile,
    database: databaseUrl
      ? {
          url: databaseUrl,
          schema: base?.[EnvVar.DatabaseSchema] ?? DEFAULT_SCHEMA,
          tablePrefix: base?.[EnvVar.DatabaseTablePrefix] ?? DEFAULT_TABLE_PREFIX,
          poolSize: base?.[EnvVar.DatabasePoolSize] ?? DEFAULT_DATABASE_POOL_SIZE,
        }
      : undefined,
    tickSeconds: base?.[EnvVar.SchedulerTickSeconds] ?? DEFAULT_TICK_SECONDS,
    eventsWebhook,
    warnings,
  };
}
