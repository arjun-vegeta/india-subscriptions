import { describe, expect, it } from 'vitest';
import { ErrorCode, Environment, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TICK_SECONDS,
  GATEWAY_ORDER,
  EnvVar,
  parseServiceEnv,
  type EnvironmentVariables,
} from '../../src/service-config.js';

const API_KEY = 'a-long-random-service-api-key';
const SECRET = 'super-secret-gateway-value-do-not-print';

const razorpayEnv: EnvironmentVariables = {
  [EnvVar.RazorpayKeyId]: 'rzp_test_id',
  [EnvVar.RazorpayKeySecret]: SECRET,
  [EnvVar.RazorpayWebhookSecret]: 'whsec',
};
const cashfreeEnv: EnvironmentVariables = {
  [EnvVar.CashfreeClientId]: 'cf_id',
  [EnvVar.CashfreeClientSecret]: SECRET,
  [EnvVar.CashfreeEnvironment]: Environment.Test,
};
const payuEnv: EnvironmentVariables = {
  [EnvVar.PayuKey]: 'payu_key',
  [EnvVar.PayuSalt]: SECRET,
  [EnvVar.PayuEnvironment]: Environment.Test,
  [EnvVar.PayuSuccessUrl]: 'https://shop.example.com/ok',
  [EnvVar.PayuFailureUrl]: 'https://shop.example.com/failed',
};

function failure(env: EnvironmentVariables, allowUnauthenticated = false): SubscriptionError {
  try {
    parseServiceEnv(env, { allowUnauthenticated });
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected parseServiceEnv to throw');
}

describe('parseServiceEnv', () => {
  it('applies the defaults', () => {
    const config = parseServiceEnv({ [EnvVar.ApiKey]: API_KEY, ...razorpayEnv });
    expect(config).toMatchObject({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      tickSeconds: DEFAULT_TICK_SECONDS,
      apiKey: API_KEY,
      allowUnauthenticated: false,
      schedulerStoreFile: undefined,
      eventsWebhook: undefined,
    });
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(8787);
    expect(DEFAULT_TICK_SECONDS).toBe(300);
    expect(Object.keys(config.gateways)).toEqual([Provider.Razorpay]);
  });

  it('maps every variable of every gateway to its adapter config', () => {
    const config = parseServiceEnv({
      [EnvVar.ApiKey]: API_KEY,
      [EnvVar.Host]: '0.0.0.0',
      [EnvVar.Port]: '9000',
      ...razorpayEnv,
      [EnvVar.RazorpayDefaultDurationYears]: '5',
      [EnvVar.RazorpayBaseUrl]: 'http://localhost:1234',
      ...cashfreeEnv,
      [EnvVar.CashfreeWebhookSecret]: 'cfwh',
      [EnvVar.CashfreeApiVersion]: '2025-01-01',
      [EnvVar.CashfreeBaseUrl]: 'http://localhost:2345/pg',
      ...payuEnv,
      [EnvVar.PayuConsentHashLayout]: 'four_pipes',
      [EnvVar.PayuAcceptUnsignedWebhooks]: 'true',
      [EnvVar.PayuPaymentUrl]: 'http://localhost:3456/_payment',
      [EnvVar.PayuApiUrl]: 'http://localhost:3456/postservice?form=2',
      [EnvVar.SchedulerStoreFile]: '/var/lib/subs/state.json',
      [EnvVar.SchedulerTickSeconds]: '60',
      [EnvVar.EventsWebhookUrl]: 'https://hooks.example.com/in',
      [EnvVar.EventsWebhookSecret]: 'evsecret',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(9000);
    expect(config.tickSeconds).toBe(60);
    expect(config.schedulerStoreFile).toBe('/var/lib/subs/state.json');
    expect(config.eventsWebhook).toEqual({ url: 'https://hooks.example.com/in', secret: 'evsecret' });
    expect(config.gateways.razorpay).toEqual({
      keyId: 'rzp_test_id',
      keySecret: SECRET,
      webhookSecret: 'whsec',
      defaultDurationYears: 5,
      baseUrl: 'http://localhost:1234',
    });
    expect(config.gateways.cashfree).toEqual({
      clientId: 'cf_id',
      clientSecret: SECRET,
      environment: Environment.Test,
      webhookSecret: 'cfwh',
      apiVersion: '2025-01-01',
      baseUrl: 'http://localhost:2345/pg',
    });
    expect(config.gateways.payu).toEqual({
      key: 'payu_key',
      salt: SECRET,
      environment: Environment.Test,
      successUrl: 'https://shop.example.com/ok',
      failureUrl: 'https://shop.example.com/failed',
      consentHashLayout: 'four_pipes',
      acceptUnsignedWebhooks: true,
      paymentUrl: 'http://localhost:3456/_payment',
      apiUrl: 'http://localhost:3456/postservice?form=2',
    });
  });

  it('treats blank variables as unset and trims values', () => {
    const config = parseServiceEnv({
      [EnvVar.ApiKey]: `  ${API_KEY}\n`,
      [EnvVar.Port]: '',
      [EnvVar.Host]: '   ',
      ...razorpayEnv,
      [EnvVar.CashfreeClientId]: '',
      [EnvVar.CashfreeEnvironment]: '  ',
    });
    expect(config.apiKey).toBe(API_KEY);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(Object.keys(config.gateways)).toEqual([Provider.Razorpay]);
  });

  it('enables each gateway independently', () => {
    const config = parseServiceEnv({ [EnvVar.ApiKey]: API_KEY, ...cashfreeEnv, ...payuEnv });
    expect(Object.keys(config.gateways).sort()).toEqual([Provider.Cashfree, Provider.PayU]);
  });

  describe('authentication', () => {
    it('requires the API key', () => {
      const error = failure(razorpayEnv);
      expect(error.code).toBe(ErrorCode.Config);
      expect(error.message).toContain(EnvVar.ApiKey);
      expect(error.message).toContain('--allow-unauthenticated');
    });

    it('lets --allow-unauthenticated stand in for the key, with a warning', () => {
      const config = parseServiceEnv(razorpayEnv, { allowUnauthenticated: true });
      expect(config.apiKey).toBeUndefined();
      expect(config.allowUnauthenticated).toBe(true);
      expect(config.warnings.join('\n')).toContain('WITHOUT an API key');
    });

    it('warns when that is combined with a public listen address', () => {
      const config = parseServiceEnv({ ...razorpayEnv, [EnvVar.Host]: '0.0.0.0' }, { allowUnauthenticated: true });
      expect(config.warnings.join('\n')).toContain('0.0.0.0');
    });

    it('prefers the key when both are given', () => {
      const config = parseServiceEnv({ ...razorpayEnv, [EnvVar.ApiKey]: API_KEY }, { allowUnauthenticated: true });
      expect(config.allowUnauthenticated).toBe(false);
      expect(config.apiKey).toBe(API_KEY);
    });

    it('warns about a short key', () => {
      const config = parseServiceEnv({ ...razorpayEnv, [EnvVar.ApiKey]: 'short' });
      expect(config.warnings.join('\n')).toContain('shorter than');
    });
  });

  describe('gateways', () => {
    it('refuses to start with no gateway at all, naming what to set', () => {
      const error = failure({ [EnvVar.ApiKey]: API_KEY });
      expect(error.message).toContain('No payment gateway or app store is configured');
      for (const name of [EnvVar.RazorpayKeyId, EnvVar.CashfreeClientId, EnvVar.PayuKey, EnvVar.PayuEnvironment]) {
        expect(error.message).toContain(name);
      }
    });

    it.each([
      ['razorpay', { [EnvVar.RazorpayKeyId]: 'id' }, [EnvVar.RazorpayKeySecret]],
      ['razorpay (only the webhook secret)', { [EnvVar.RazorpayWebhookSecret]: 'x' }, [EnvVar.RazorpayKeyId, EnvVar.RazorpayKeySecret]],
      ['cashfree', { [EnvVar.CashfreeClientId]: 'id', [EnvVar.CashfreeClientSecret]: 's' }, [EnvVar.CashfreeEnvironment]],
      ['payu', { [EnvVar.PayuKey]: 'k' }, [EnvVar.PayuSalt, EnvVar.PayuEnvironment]],
    ])('refuses a half-configured gateway: %s', (_name, partial, missing) => {
      const error = failure({ [EnvVar.ApiKey]: API_KEY, ...partial });
      for (const name of missing) expect(error.message).toContain(`${name}: is required`);
      expect(error.message).not.toContain('No payment gateway or app store is configured');
    });

    it('a broken gateway is an error even when another one is fine', () => {
      const error = failure({ [EnvVar.ApiKey]: API_KEY, ...razorpayEnv, [EnvVar.PayuKey]: 'k' });
      expect(error.message).toContain(EnvVar.PayuSalt);
    });

    it('reports every problem at once', () => {
      const error = failure({
        [EnvVar.Port]: 'abc',
        [EnvVar.RazorpayKeyId]: 'id',
        [EnvVar.CashfreeClientId]: 'id',
      });
      for (const name of [EnvVar.ApiKey, EnvVar.Port, EnvVar.RazorpayKeySecret, EnvVar.CashfreeClientSecret, EnvVar.CashfreeEnvironment]) {
        expect(error.message).toContain(name);
      }
    });

    it('names the variable behind an adapter-level rejection', () => {
      const error = failure({ [EnvVar.ApiKey]: API_KEY, ...cashfreeEnv, [EnvVar.CashfreeApiVersion]: 'latest' });
      expect(error.message).toContain(`${EnvVar.CashfreeApiVersion}:`);
    });
  });

  describe('validation', () => {
    const base = { [EnvVar.ApiKey]: API_KEY, ...razorpayEnv };
    it.each([
      [EnvVar.Port, 'abc'],
      [EnvVar.Port, '70000'],
      [EnvVar.Port, '-1'],
      [EnvVar.Port, '80.5'],
      [EnvVar.SchedulerTickSeconds, '0'],
      [EnvVar.SchedulerTickSeconds, 'often'],
      [EnvVar.SchedulerTickSeconds, '100000'],
      [EnvVar.RazorpayDefaultDurationYears, '0'],
      [EnvVar.RazorpayDefaultDurationYears, '101'],
      [EnvVar.RazorpayBaseUrl, 'not a url'],
      [EnvVar.EventsWebhookUrl, 'ftp://example.com/x'],
      [EnvVar.EventsWebhookUrl, 'nope'],
    ])('rejects %s=%s', (name, value) => {
      const env = { ...base, [name]: value, ...(name === EnvVar.EventsWebhookUrl ? { [EnvVar.EventsWebhookSecret]: 's' } : {}) };
      const error = failure(env);
      expect(error.code).toBe(ErrorCode.Config);
      expect(error.message).toContain(`${name}:`);
    });

    it.each([
      [EnvVar.CashfreeEnvironment, 'production', cashfreeEnv],
      [EnvVar.PayuEnvironment, 'sandbox', payuEnv],
      [EnvVar.PayuConsentHashLayout, 'seven_pipes', payuEnv],
      [EnvVar.PayuAcceptUnsignedWebhooks, 'maybe', payuEnv],
      [EnvVar.PayuSuccessUrl, 'shop', payuEnv],
    ])('rejects %s=%s', (name, value, gateway) => {
      const error = failure({ [EnvVar.ApiKey]: API_KEY, ...gateway, [name]: value });
      expect(error.message).toContain(`${name}:`);
    });

    it('accepts port 0 (a free port)', () => {
      expect(parseServiceEnv({ ...base, [EnvVar.Port]: '0' }).port).toBe(0);
    });

    it('needs the events webhook URL and secret together', () => {
      expect(failure({ ...base, [EnvVar.EventsWebhookUrl]: 'https://x.example.com' }).message).toContain(
        `${EnvVar.EventsWebhookSecret}: is required`,
      );
      expect(failure({ ...base, [EnvVar.EventsWebhookSecret]: 's' }).message).toContain(
        `${EnvVar.EventsWebhookUrl}: is required`,
      );
    });

    it('warns about a plain-http events webhook', () => {
      const config = parseServiceEnv({
        ...base,
        [EnvVar.EventsWebhookUrl]: 'http://hooks.example.com/in',
        [EnvVar.EventsWebhookSecret]: 's',
      });
      expect(config.warnings.join('\n')).toContain('plain http');
    });
  });

  it('never puts a secret value in an error or a warning', () => {
    const secrets = [SECRET, API_KEY, 'whsec-value', 'evsecret-value'];
    const messages: string[] = [];
    const attempts: EnvironmentVariables[] = [
      { [EnvVar.RazorpayKeyId]: 'id', [EnvVar.RazorpayWebhookSecret]: secrets[2] },
      { [EnvVar.CashfreeClientSecret]: SECRET, [EnvVar.CashfreeEnvironment]: SECRET },
      { [EnvVar.PayuSalt]: SECRET, [EnvVar.PayuEnvironment]: SECRET, [EnvVar.PayuConsentHashLayout]: SECRET, [EnvVar.PayuKey]: 'k' },
      { ...razorpayEnv, [EnvVar.Port]: SECRET, [EnvVar.EventsWebhookUrl]: SECRET, [EnvVar.EventsWebhookSecret]: secrets[3] },
      { ...razorpayEnv, [EnvVar.ApiKey]: API_KEY, [EnvVar.EventsWebhookSecret]: secrets[3] },
    ];
    for (const env of attempts) messages.push(failure(env).message);
    const ok = parseServiceEnv({ ...razorpayEnv, [EnvVar.ApiKey]: API_KEY });
    messages.push(...ok.warnings);
    for (const message of messages) for (const secret of secrets) expect(message).not.toContain(secret);
  });
});

const phonepeEnv: EnvironmentVariables = {
  [EnvVar.PhonepeClientId]: 'pp_client',
  [EnvVar.PhonepeClientSecret]: SECRET,
  [EnvVar.PhonepeClientVersion]: '1',
  [EnvVar.PhonepeEnvironment]: Environment.Test,
};
const MERCHANT_KEY = 'ABCDEFGHIJKLMNOP'; // exactly 16 bytes
const paytmEnv: EnvironmentVariables = {
  [EnvVar.PaytmMid]: 'MID_TEST_123',
  [EnvVar.PaytmMerchantKey]: MERCHANT_KEY,
  [EnvVar.PaytmWebsite]: 'WEBSTAGING',
  [EnvVar.PaytmEnvironment]: Environment.Test,
};

describe('PhonePe and Paytm', () => {
  const base = { [EnvVar.ApiKey]: API_KEY };

  it('enables them, in the documented order', () => {
    const config = parseServiceEnv({ ...base, ...paytmEnv, ...phonepeEnv, ...razorpayEnv });
    expect(Object.keys(config.gateways).sort()).toEqual([Provider.Paytm, Provider.PhonePe, Provider.Razorpay]);
    expect(GATEWAY_ORDER).toEqual([Provider.Razorpay, Provider.Cashfree, Provider.PayU, Provider.PhonePe, Provider.Paytm]);
  });

  it('maps every PhonePe variable to its adapter config', () => {
    const config = parseServiceEnv({
      ...base,
      ...phonepeEnv,
      [EnvVar.PhonepeClientVersion]: '2',
      [EnvVar.PhonepeWebhookUsername]: 'hook-user',
      [EnvVar.PhonepeWebhookPassword]: 'hook-pass',
      [EnvVar.PhonepeRedirectUrl]: 'https://shop.example.com/done',
      [EnvVar.PhonepeApiUrl]: 'http://localhost:4001',
      [EnvVar.PhonepeTokenUrl]: 'http://localhost:4001/token',
    });
    expect(config.gateways.phonepe).toEqual({
      clientId: 'pp_client',
      clientSecret: SECRET,
      clientVersion: '2',
      environment: Environment.Test,
      webhookUsername: 'hook-user',
      webhookPassword: 'hook-pass',
      redirectUrl: 'https://shop.example.com/done',
      apiUrl: 'http://localhost:4001',
      tokenUrl: 'http://localhost:4001/token',
    });
    expect(config.warnings.join('\n')).not.toContain('phonepe will be rejected');
  });

  it('warns when PhonePe has no webhook credentials', () => {
    const config = parseServiceEnv({ ...base, ...phonepeEnv });
    expect(config.warnings.join('\n')).toContain('webhooks from phonepe will be rejected');
  });

  it('maps every Paytm variable to its adapter config', () => {
    const config = parseServiceEnv({
      ...base,
      ...paytmEnv,
      [EnvVar.PaytmCallbackUrl]: 'https://shop.example.com/back',
      [EnvVar.PaytmChannelId]: 'WAP',
      [EnvVar.PaytmClientId]: 'C11',
      [EnvVar.PaytmGraceDays]: '7',
      [EnvVar.PaytmRetryCount]: '4',
      [EnvVar.PaytmMandateYears]: '10',
      [EnvVar.PaytmDebitReason]: 'Monthly plan',
      [EnvVar.PaytmSubscriptionBaseUrl]: 'http://localhost:4002',
      [EnvVar.PaytmTransactionStatusBaseUrl]: 'http://localhost:4003',
      [EnvVar.PaytmRefundBaseUrl]: 'http://localhost:4004',
      [EnvVar.PaytmCheckoutBaseUrl]: 'http://localhost:4005',
    });
    expect(config.gateways.paytm).toEqual({
      mid: 'MID_TEST_123',
      merchantKey: MERCHANT_KEY,
      website: 'WEBSTAGING',
      environment: Environment.Test,
      callbackUrl: 'https://shop.example.com/back',
      channelId: 'WAP',
      clientId: 'C11',
      graceDays: 7,
      retryCount: 4,
      mandateYears: 10,
      debitReason: 'Monthly plan',
      subscriptionBaseUrl: 'http://localhost:4002',
      transactionStatusBaseUrl: 'http://localhost:4003',
      refundBaseUrl: 'http://localhost:4004',
      checkoutBaseUrl: 'http://localhost:4005',
    });
  });

  it('leaves the optional Paytm fields to the adapter defaults', () => {
    const paytm = parseServiceEnv({ ...base, ...paytmEnv }).gateways.paytm;
    expect(paytm).toMatchObject({ mid: 'MID_TEST_123', website: 'WEBSTAGING' });
    expect(paytm?.graceDays).toBeUndefined();
    expect(paytm?.mandateYears).toBeUndefined();
    expect(paytm?.debitReason).toBeUndefined();
  });

  it.each([
    ['phonepe (only the id)', { [EnvVar.PhonepeClientId]: 'x' }, [EnvVar.PhonepeClientSecret, EnvVar.PhonepeClientVersion, EnvVar.PhonepeEnvironment]],
    ['phonepe (only a URL override)', { [EnvVar.PhonepeApiUrl]: 'http://localhost:1' }, [EnvVar.PhonepeClientId, EnvVar.PhonepeClientSecret]],
    ['phonepe (no environment)', { ...phonepeEnv, [EnvVar.PhonepeEnvironment]: undefined }, [EnvVar.PhonepeEnvironment]],
    ['paytm (only the mid)', { [EnvVar.PaytmMid]: 'm' }, [EnvVar.PaytmMerchantKey, EnvVar.PaytmWebsite, EnvVar.PaytmEnvironment]],
    ['paytm (only an optional)', { [EnvVar.PaytmGraceDays]: '3' }, [EnvVar.PaytmMid, EnvVar.PaytmMerchantKey]],
    ['paytm (no website)', { ...paytmEnv, [EnvVar.PaytmWebsite]: undefined }, [EnvVar.PaytmWebsite]],
  ])('refuses a half-configured gateway: %s', (_name, partial, missing) => {
    const error = failure({ ...base, ...partial });
    for (const name of missing) expect(error.message).toContain(`${name}: is required`);
    expect(error.message).not.toContain('No payment gateway or app store is configured');
  });

  it('needs the PhonePe webhook username and password together', () => {
    expect(failure({ ...base, ...phonepeEnv, [EnvVar.PhonepeWebhookUsername]: 'u' }).message).toContain(
      `${EnvVar.PhonepeWebhookPassword}: is required when ${EnvVar.PhonepeWebhookUsername} is set`,
    );
    expect(failure({ ...base, ...phonepeEnv, [EnvVar.PhonepeWebhookPassword]: 'p' }).message).toContain(
      `${EnvVar.PhonepeWebhookUsername}: is required when ${EnvVar.PhonepeWebhookPassword} is set`,
    );
  });

  it.each([
    [EnvVar.PhonepeEnvironment, 'sandbox', phonepeEnv],
    [EnvVar.PhonepeRedirectUrl, 'not a url', phonepeEnv],
    [EnvVar.PhonepeApiUrl, 'nope', phonepeEnv],
    [EnvVar.PhonepeTokenUrl, 'nope', phonepeEnv],
    [EnvVar.PaytmEnvironment, 'production', paytmEnv],
    [EnvVar.PaytmChannelId, 'APP', paytmEnv],
    [EnvVar.PaytmGraceDays, '366', paytmEnv],
    [EnvVar.PaytmGraceDays, 'x', paytmEnv],
    [EnvVar.PaytmRetryCount, '0', paytmEnv],
    [EnvVar.PaytmRetryCount, '11', paytmEnv],
    [EnvVar.PaytmMandateYears, '0', paytmEnv],
    [EnvVar.PaytmMandateYears, '31', paytmEnv],
    [EnvVar.PaytmDebitReason, 'x'.repeat(51), paytmEnv],
    [EnvVar.PaytmCallbackUrl, 'nope', paytmEnv],
    [EnvVar.PaytmSubscriptionBaseUrl, 'nope', paytmEnv],
    [EnvVar.PaytmTransactionStatusBaseUrl, 'nope', paytmEnv],
    [EnvVar.PaytmRefundBaseUrl, 'nope', paytmEnv],
    [EnvVar.PaytmCheckoutBaseUrl, 'nope', paytmEnv],
  ])('rejects %s=%s', (name, value, gateway) => {
    const error = failure({ ...base, ...gateway, [name]: value });
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain(`${name}:`);
  });

  it('lets the Paytm adapter schema have the last word, naming the variable', () => {
    const error = failure({ ...base, ...paytmEnv, [EnvVar.PaytmMerchantKey]: 'too-short' });
    expect(error.message).toContain(`${EnvVar.PaytmMerchantKey}:`);
    expect(error.message).toContain('16 bytes');
    expect(error.message).not.toContain('too-short');
  });

  it('never puts a PhonePe or Paytm secret in an error or a warning', () => {
    const secrets = [SECRET, 'phonepe-hook-password', 'too-short-secret-key', MERCHANT_KEY];
    const messages = [
      failure({ ...base, [EnvVar.PhonepeClientSecret]: SECRET, [EnvVar.PhonepeWebhookPassword]: secrets[1] }).message,
      failure({ ...base, ...phonepeEnv, [EnvVar.PhonepeEnvironment]: SECRET }).message,
      failure({ ...base, ...paytmEnv, [EnvVar.PaytmMerchantKey]: secrets[2] }).message,
      failure({ ...base, ...paytmEnv, [EnvVar.PaytmEnvironment]: MERCHANT_KEY }).message,
      failure({ ...base, [EnvVar.PaytmMerchantKey]: MERCHANT_KEY }).message,
      ...parseServiceEnv({ ...base, ...phonepeEnv, ...paytmEnv }).warnings,
    ];
    for (const message of messages) for (const secret of secrets) expect(message).not.toContain(secret);
  });

  it('names every new gateway in the "no gateway configured" message', () => {
    const error = failure(base);
    for (const name of [EnvVar.PhonepeClientId, EnvVar.PhonepeClientVersion, EnvVar.PaytmMid, EnvVar.PaytmMerchantKey]) {
      expect(error.message).toContain(name);
    }
  });
});
