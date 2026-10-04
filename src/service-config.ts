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

  SchedulerStoreFile: 'SCHEDULER_STORE_FILE',
  SchedulerTickSeconds: 'SCHEDULER_TICK_SECONDS',

  EventsWebhookUrl: 'EVENTS_WEBHOOK_URL',
  EventsWebhookSecret: 'EVENTS_WEBHOOK_SECRET',
} as const;
export type EnvVar = (typeof EnvVar)[keyof typeof EnvVar];

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_TICK_SECONDS = 300;
/** Longest tick interval accepted: a day. */
export const MAX_TICK_SECONDS = 86_400;
/** Keys shorter than this still work but earn a warning. */
export const MIN_RECOMMENDED_API_KEY_LENGTH = 16;
const MAX_PORT = 65_535;
const LOOPBACK_HOSTS: readonly string[] = [DEFAULT_HOST, 'localhost', '::1'];
const WEBHOOK_PROTOCOLS: readonly string[] = ['http:', 'https:'];
const INSECURE_PROTOCOL = 'http:';
const WHOLE_NUMBER = /^\d+$/;

/** Variables of each gateway. Any of them being set means the gateway is meant to be on. */
const GATEWAY_VARS: Record<EnvGateway, readonly EnvVar[]> = {
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
};

/** The variables a gateway cannot work without. */
const GATEWAY_REQUIRED_VARS: Record<EnvGateway, readonly EnvVar[]> = {
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
};

/** Which variable feeds which field of each adapter's config, to name the variable when the adapter's schema objects. */
const CONFIG_FIELD_VARS: Record<EnvGateway, Record<string, EnvVar>> = {
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

const urlText = z.url({ error: 'must be a valid URL' });
const environmentText = z.enum(Environment, {
  error: (issue) => (issue.input === undefined ? REQUIRED_MESSAGE : 'must be "test" or "live"'),
});
const flag = z.stringbool({ error: 'must be "true" or "false"' });

const ServiceEnvSchema = z.object({
  [EnvVar.ApiKey]: z.string().optional(),
  [EnvVar.Host]: z.string().optional(),
  [EnvVar.Port]: wholeNumber(0, MAX_PORT).optional(),
  [EnvVar.SchedulerStoreFile]: z.string().optional(),
  [EnvVar.SchedulerTickSeconds]: wholeNumber(1, MAX_TICK_SECONDS).optional(),
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
  env: Record<string, string | undefined>,
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

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface EventsWebhookConfig {
  url: string;
  secret: string;
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
  /** Path of the scheduler's `FileSchedulerStore`. Absent: the billing scheduler is off. */
  schedulerStoreFile?: string;
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

const GATEWAY_ENV_SCHEMAS = {
  [Provider.Razorpay]: { env: RazorpayEnvSchema, config: RazorpayConfigSchema },
  [Provider.Cashfree]: { env: CashfreeEnvSchema, config: CashfreeConfigSchema },
  [Provider.PayU]: { env: PayuEnvSchema, config: PayUConfigSchema },
  [Provider.PhonePe]: { env: PhonepeEnvSchema, config: PhonePeConfigSchema },
  [Provider.Paytm]: { env: PaytmEnvSchema, config: PaytmConfigSchema },
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

function describeGatewayVars(provider: EnvGateway): string {
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

  // Gateways.
  const gateways: ServiceConfig['gateways'] = {};
  let anyGatewayVariable = false;
  for (const provider of GATEWAY_ORDER) {
    const present = GATEWAY_VARS[provider].filter((name) => values[name] !== undefined);
    if (present.length === 0) continue;
    anyGatewayVariable = true;
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
    (gateways as Record<string, unknown>)[provider] = fromEnv.data;
  }

  if (!anyGatewayVariable) {
    problems.push(
      'No payment gateway is configured. Set the variables of at least one: ' +
        GATEWAY_ORDER.map((provider) => describeGatewayVars(provider)).join('; '),
    );
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
    schedulerStoreFile: base?.[EnvVar.SchedulerStoreFile],
    tickSeconds: base?.[EnvVar.SchedulerTickSeconds] ?? DEFAULT_TICK_SECONDS,
    eventsWebhook,
    warnings,
  };
}
