/**
 * Assembles the self-hosted service from environment variables and runs it.
 * `cli.ts` is a thin wrapper around `runServe`; everything here is importable
 * and testable without spawning a process.
 */
import type { Server } from 'node:http';
import { ErrorCode, Provider, SchedulingMode } from './constants.js';
import { Subscriptions, createSubscriptions } from './client.js';
import { SubscriptionError, isSubscriptionError } from './errors.js';
import {
  createEventsForwarder,
  createSchedulerEventsRelay,
  originOf,
  type SchedulerEventsRelay,
} from './events-webhook.js';
import type { FetchLike } from './http.js';
import type { SubscriptionProvider } from './provider.js';
import { appStore } from './providers/appstore/index.js';
import { cashfree } from './providers/cashfree/index.js';
import { googlePlay } from './providers/googleplay/index.js';
import { payu } from './providers/payu/index.js';
import { paytm } from './providers/paytm/index.js';
import { phonepe } from './providers/phonepe/index.js';
import { razorpay } from './providers/razorpay/index.js';
import { Purchases } from './purchase/purchases.js';
import { FlushOutcome } from './purchase/constants.js';
import type { FlushResult } from './purchase/schemas.js';
import { BillingScheduler } from './scheduler/scheduler.js';
import type { TickResult } from './scheduler/schemas.js';
import { FilePurchaseStore } from './purchase-file-store.js';
import { FileSchedulerStore } from './scheduler-file-store.js';
import { GATEWAY_RETURN_ID_FIELD } from './server/checkout.js';
import { ApiPath, PathParam } from './server/constants.js';
import { RETURN_URL_MAX_LENGTH } from './providers/payu/constants.js';
import { loadPurchasesFile } from './service-purchases.js';
import { createNodeServer, listen, type RunningServer } from './server/node.js';
import type { EventsHook } from './server/routes.js';
import {
  GATEWAY_ORDER,
  STORE_ORDER,
  EnvVar,
  parseServiceEnv,
  type EnvironmentVariables,
  type ServiceConfig,
} from './service-config.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

const MILLIS_PER_SECOND = 1000;
/** At most this many failing schedules are named in one tick's log line. */
const MAX_LOGGED_TICK_ERRORS = 5;
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/** Where the service writes. Messages never contain secrets. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** A logger that writes information through `stdout` and problems through `stderr`. */
export function createStreamLogger(stdout: (text: string) => void, stderr: (text: string) => void): Logger {
  return {
    info: (message) => stdout(`${message}\n`),
    warn: (message) => stderr(`warning: ${message}\n`),
    error: (message) => stderr(`error: ${message}\n`),
  };
}

/** Writes information to stdout and problems to stderr. */
export const consoleLogger: Logger = createStreamLogger(
  (text) => process.stdout.write(text),
  (text) => process.stderr.write(text),
);

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface BuildServiceOptions {
  /** The `--allow-unauthenticated` flag. */
  allowUnauthenticated?: boolean;
  /** `fetch` for every gateway adapter and for the events webhook (tests, proxies). */
  fetch?: FetchLike;
  logger?: Logger;
}

/** Everything `serve` needs, built but not yet listening. */
export interface Service {
  /** Validated configuration. Holds secrets: never log it. */
  readonly config: ServiceConfig;
  readonly client: Subscriptions;
  /** Present when `SCHEDULER_STORE_FILE` is set. */
  readonly scheduler?: BillingScheduler;
  readonly store?: FileSchedulerStore;
  /** Present when `PURCHASES_FILE` is set: purchase sessions, entitlements and the Google report queue (`client.purchases`). */
  readonly purchases?: Purchases;
  /** Present when `PURCHASE_STORE_FILE` is set. */
  readonly purchaseStore?: FilePurchaseStore;
  /** Present when `EVENTS_WEBHOOK_URL` is set: forwards gateway webhook events. */
  readonly onEvents?: EventsHook;
  /** Present when both `EVENTS_WEBHOOK_URL` and `SCHEDULER_STORE_FILE` are set: forwards scheduler events. */
  readonly schedulerEvents?: SchedulerEventsRelay;
  /** A `node:http` server for the API, not yet listening. */
  createServer(): Server;
  /** The startup report: enabled gateways, listen URL, scheduler. Free of secrets. `config.warnings` are separate. */
  describe(listenUrl: string): string[];
  /** Stops the scheduler events relay (waiting for the delivery in flight) and releases the scheduler store. */
  close(): Promise<void>;
}

/**
 * Validates `env`, builds the gateways, the billing scheduler (when
 * `SCHEDULER_STORE_FILE` is set), the client and the events hook. Throws one
 * `SubscriptionError` listing every configuration problem, or `CONFIG` when the
 * scheduler's file exists but is not a valid store.
 */
export async function buildService(env: EnvironmentVariables, options: BuildServiceOptions = {}): Promise<Service> {
  const logger = options.logger ?? consoleLogger;
  const config = parseServiceEnv(env, { allowUnauthenticated: options.allowUnauthenticated });
  const providerOptions = options.fetch ? { fetch: options.fetch } : {};

  const providers: SubscriptionProvider[] = [];
  const {
    razorpay: razorpayConfig,
    cashfree: cashfreeConfig,
    payu: payuConfig,
    phonepe: phonepeConfig,
    paytm: paytmConfig,
  } = {
    razorpay: config.gateways[Provider.Razorpay],
    cashfree: config.gateways[Provider.Cashfree],
    payu: config.gateways[Provider.PayU],
    phonepe: config.gateways[Provider.PhonePe],
    paytm: config.gateways[Provider.Paytm],
  };
  if (razorpayConfig) providers.push(razorpay(razorpayConfig, providerOptions));
  if (cashfreeConfig) providers.push(cashfree(cashfreeConfig, providerOptions));
  if (payuConfig) providers.push(payu(payuConfig, providerOptions));
  if (phonepeConfig) providers.push(phonepe(phonepeConfig, providerOptions));
  if (paytmConfig) providers.push(paytm(paytmConfig, providerOptions));
  const appStoreConfig = config.stores[Provider.AppStore];
  const googlePlayConfig = config.stores[Provider.GooglePlay];
  if (appStoreConfig) providers.push(appStore(appStoreConfig, providerOptions));
  if (googlePlayConfig) providers.push(googlePlay(googlePlayConfig, providerOptions));

  const eventsWebhook = config.eventsWebhook;
  const schedulerEvents = eventsWebhook && config.schedulerStoreFile
    ? createSchedulerEventsRelay({ ...eventsWebhook, fetch: options.fetch, logger })
    : undefined;

  let store: FileSchedulerStore | undefined;
  let scheduler: BillingScheduler | undefined;
  if (config.schedulerStoreFile) {
    store = await FileSchedulerStore.open(config.schedulerStoreFile);
    const byName = new Map(providers.map((provider) => [provider.name, provider] as const));
    scheduler = new BillingScheduler({
      store,
      resolveProvider: (name) => {
        const provider = byName.get(name);
        if (!provider) throw new SubscriptionError(ErrorCode.Config, `Provider ${String(name)} is not configured`);
        return provider;
      },
      onEvent: (event) => {
        logger.info(`scheduler: ${event.type} ${event.scheduleId}`);
        schedulerEvents?.enqueue(event);
      },
    });
  }

  warnAboutReturnUrlLimits(config);

  let purchaseStore: FilePurchaseStore | undefined;
  let client: Subscriptions;
  try {
    const purchasesConfig = config.purchasesFile
      ? await loadPurchasesFile(config.purchasesFile, {
          capabilities: providers.map((provider) => provider.capabilities),
          hasReporter: googlePlayConfig !== undefined,
          publicBaseUrl: config.publicBaseUrl,
        })
      : undefined;
    if (purchasesConfig && config.purchaseStoreFile) purchaseStore = await FilePurchaseStore.open(config.purchaseStoreFile);
    const base = config.publicBaseUrl;
    client = createSubscriptions({
      providers,
      scheduler,
      routing: {
        ...(purchasesConfig?.routing ? { strategy: purchasesConfig.routing } : {}),
        onStatsError: (error) => logger.warn(`routing statistics unavailable: ${describeError(error)}`),
      },
      ...(purchasesConfig && purchaseStore
        ? {
            purchases: {
              catalog: purchasesConfig.catalog,
              policy: purchasesConfig.policy,
              store: purchaseStore,
              onIssue: (issue) =>
                logger.warn(
                  `purchases: ${issue.issue}: ${issue.message}${issue.error === undefined ? '' : ` (${describeError(issue.error)})`}`,
                ),
              ...(base
                ? {
                    gatewayReturnUrl: (sessionId: string, provider: Provider) => gatewayReturnUrl(base, sessionId, provider),
                    hostedCheckoutUrl: (sessionId: string) => checkoutUrl(base, sessionId, ApiPath.Checkout),
                  }
                : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    await schedulerEvents?.close();
    await store?.close();
    await purchaseStore?.close();
    throw error;
  }

  const onEvents = eventsWebhook ? createEventsForwarder({ ...eventsWebhook, fetch: options.fetch }) : undefined;

  return {
    config,
    client,
    scheduler,
    store,
    purchases: client.purchases,
    purchaseStore,
    onEvents,
    schedulerEvents,
    createServer: () =>
      createNodeServer({
        client,
        apiKey: config.apiKey,
        allowUnauthenticated: config.allowUnauthenticated,
        onEvents,
      }),
    describe: (listenUrl) => describeService(config, client, listenUrl),
    close: async () => {
      await schedulerEvents?.close();
      await store?.close();
      await purchaseStore?.close();
    },
  };
}

/**
 * The return address a gateway is given. Every gateway gets the session's own (`/checkout/{sessionId}/return`), except the
 * gateways that post back the merchant's transaction id and cannot take a long address: they get one fixed address for all
 * sessions (`/checkout/return/{gateway}`), and the session is found by the transaction id.
 */
function gatewayReturnUrl(base: string, sessionId: string, provider: Provider): string {
  return provider in GATEWAY_RETURN_ID_FIELD
    ? `${base}${ApiPath.CheckoutReturnByGateway.replace(`{${PathParam.Gateway}}`, provider)}`
    : checkoutUrl(base, sessionId, ApiPath.CheckoutReturn);
}

/**
 * PayU accepts return URLs of at most 50 characters. It gets the fixed provider-level address, which fits a short enough
 * `PUBLIC_BASE_URL`; when even that is too long PayU refuses the purchase, and the purchase module goes on to the next
 * gateway. Say so at startup.
 */
function warnAboutReturnUrlLimits(config: ServiceConfig): void {
  if (!config.gateways[Provider.PayU] || !config.purchasesFile || !config.publicBaseUrl) return;
  const address = gatewayReturnUrl(config.publicBaseUrl, '', Provider.PayU);
  if (address.length <= RETURN_URL_MAX_LENGTH) return;
  config.warnings.push(
    `payu accepts return URLs of at most ${RETURN_URL_MAX_LENGTH} characters and its hosted checkout return URL is ${address.length}: ` +
      `payu will be skipped for hosted purchases, which go to the next gateway. Use a shorter ${EnvVar.PublicBaseUrl} to offer payu.`,
  );
}

/** `{base}/checkout/{sessionId}` (or `.../return`): the hosted checkout of a session, built on the service's public URL. */
function checkoutUrl(base: string, sessionId: string, template: string): string {
  return `${base}${template.replace(`{${PathParam.SessionId}}`, encodeURIComponent(sessionId))}`;
}

/**
 * What a missing scheduler means, per gateway, from what its adapter declares (the same rule the client applies):
 * - only merchant scheduling (PayU, PhonePe): every subscription is refused;
 * - both, merchant first (Paytm): a plan that does not ask for `gateway` scheduling is refused;
 * - both, gateway first (Cashfree): only a plan that asks for `merchant` scheduling is refused.
 * Gateways that raise every debit themselves (Razorpay) are not mentioned.
 */
function schedulerConsequence(enabled: readonly Provider[], client: Subscriptions): string {
  const always: Provider[] = [];
  const clauses: string[] = [];
  for (const provider of enabled) {
    const { merchantCharges, scheduling } = client.capabilities(provider);
    const merchant = scheduling.includes(SchedulingMode.Merchant);
    if (!merchantCharges && !merchant) continue;
    if (scheduling.every((mode) => mode === SchedulingMode.Merchant)) always.push(provider);
    else if (scheduling[0] === SchedulingMode.Merchant) {
      clauses.push(`${provider} bills through the scheduler unless a plan asks for scheduling "${SchedulingMode.Gateway}": those subscriptions will be refused`);
    } else {
      clauses.push(`${provider} subscriptions on plans with scheduling "${SchedulingMode.Merchant}" will be refused`);
    }
  }
  if (always.length > 0) {
    clauses.unshift(
      `${always.join(', ')} bill${always.length === 1 ? 's' : ''} through the scheduler, so creating a subscription there will be refused`,
    );
  }
  return clauses.length > 0 ? clauses.join('; ') : 'none of the enabled gateways needs it';
}

function describeService(config: ServiceConfig, client: Subscriptions, listenUrl: string): string[] {
  const enabled = GATEWAY_ORDER.filter((provider) => config.gateways[provider]);
  const stores = STORE_ORDER.filter((provider) => config.stores[provider]);
  const lines = [
    `${PACKAGE_NAME} ${PACKAGE_VERSION}`,
    `gateways enabled: ${enabled.length > 0 ? enabled.join(', ') : 'none'}`,
    ...(stores.length > 0 ? [`app stores enabled: ${stores.join(', ')}`] : []),
    `listening on ${listenUrl}`,
  ];
  if (config.schedulerStoreFile) {
    lines.push(`billing scheduler: on (store ${config.schedulerStoreFile}, tick every ${config.tickSeconds}s)`);
  } else {
    const consequence = schedulerConsequence(enabled, client);
    lines.push(`billing scheduler: OFF (${EnvVar.SchedulerStoreFile} is not set; ${consequence})`);
  }
  lines.push(describePurchases(config, client));
  lines.push(
    config.apiKey
      ? 'authentication: API key required (bearer token)'
      : 'authentication: DISABLED (--allow-unauthenticated)',
  );
  lines.push(
    config.eventsWebhook
      ? `events webhook: ${originOf(config.eventsWebhook.url)} (signed; gateway events${config.schedulerStoreFile ? ' and scheduler events' : ''})`
      : `events webhook: off (${EnvVar.EventsWebhookUrl} is not set)`,
  );
  return lines;
}

function describePurchases(config: ServiceConfig, client: Subscriptions): string {
  if (!client.purchases || !config.purchasesFile) {
    return `purchases: OFF (${EnvVar.PurchasesFile} is not set: the purchase and entitlement routes answer with a configuration error)`;
  }
  const hosted = config.publicBaseUrl
    ? `hosted checkout on ${originOf(config.publicBaseUrl)}`
    : `hosted checkout OFF (${EnvVar.PublicBaseUrl} is not set)`;
  const reports = client.providers.includes(Provider.GooglePlay) ? 'Google reports flushed on every tick' : 'no Google reports';
  return `purchases: on (file ${config.purchasesFile}, state ${config.purchaseStoreFile}, ${hosted}, ${reports}, tick every ${config.tickSeconds}s)`;
}

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

export interface TickLoopOptions {
  /** Runs the billing scheduler on every tick. */
  scheduler?: Pick<BillingScheduler, 'tick'>;
  /** Sends the queued Google reports on every tick (`purchases.flush`). */
  purchases?: Pick<Purchases, 'flush'>;
  intervalMs: number;
  logger?: Logger;
}

export interface TickLoop {
  /** Starts ticking: once now, then every interval. Idempotent. */
  start(): void;
  /** Stops scheduling and waits for a tick in flight to finish. */
  stop(): Promise<void>;
  /**
   * One tick now: the scheduler tick, then the report flush, each when configured and each independent of the other's
   * failure. Resolves the scheduler's result, `undefined` (and logs) when it failed, is not configured, or another tick is
   * still running.
   */
  runOnce(): Promise<TickResult | undefined>;
}

/**
 * Calls `scheduler.tick()` and `purchases.flush()` on an interval, never overlapping itself: a tick that is still
 * running makes the next interval skip. A failing tick or flush is logged, never thrown, and the loop carries on.
 */
export function createTickLoop(options: TickLoopOptions): TickLoop {
  const logger = options.logger ?? consoleLogger;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<TickResult | undefined> | undefined;
  let stopped = false;

  async function tickOnce(): Promise<TickResult | undefined> {
    let result: TickResult | undefined;
    if (options.scheduler) {
      try {
        result = await options.scheduler.tick();
        logTick(logger, result);
      } catch (error) {
        logger.error(`scheduler tick failed: ${describeError(error)}`);
      }
    }
    if (options.purchases) {
      try {
        logFlush(logger, await options.purchases.flush());
      } catch (error) {
        logger.error(`purchase report flush failed: ${describeError(error)}`);
      }
    }
    return result;
  }

  function runOnce(): Promise<TickResult | undefined> {
    if (running) {
      logger.warn('scheduler tick skipped: the previous tick is still running');
      return Promise.resolve(undefined);
    }
    const current = tickOnce().finally(() => {
      running = undefined;
    });
    running = current;
    return current;
  }

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => void runOnce(), options.intervalMs);
      void runOnce();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
    runOnce,
  };
}

function logTick(logger: Logger, result: TickResult): void {
  const busy =
    result.due + result.notified + result.charged + result.reconciled + result.succeeded + result.failed > 0;
  if (!busy && result.errors.length === 0) return;
  logger.info(
    `scheduler tick: due=${result.due} notified=${result.notified} charged=${result.charged} ` +
      `reconciled=${result.reconciled} succeeded=${result.succeeded} failed=${result.failed} ` +
      `halted=${result.halted} errors=${result.errors.length}`,
  );
  for (const error of result.errors.slice(0, MAX_LOGGED_TICK_ERRORS)) {
    logger.warn(`scheduler tick: ${error.scheduleId}: ${error.code}: ${error.message}`);
  }
}

/**
 * One line of counts when anything happened or anything is late, and one warning per rejected or overdue report. Only ids,
 * kinds and codes: never what a report says (amounts, the customer's state, the transaction token) and never Google's
 * error text, which may quote the request.
 */
function logFlush(logger: Logger, result: FlushResult): void {
  const busy = result.sent + result.retrying + result.blocked + result.rejected + result.skipped + result.overdue.length > 0;
  if (!busy) return;
  logger.info(
    `purchase reports: sent=${result.sent} retrying=${result.retrying} blocked=${result.blocked} ` +
      `rejected=${result.rejected} skipped=${result.skipped} overdue=${result.overdue.length}`,
  );
  for (const entry of result.entries.filter((candidate) => candidate.outcome === FlushOutcome.Rejected).slice(0, MAX_LOGGED_TICK_ERRORS)) {
    logger.warn(`purchase report ${entry.id} (${entry.kind}) was rejected: ${entry.errorCode ?? 'no code'}; it will not be retried`);
  }
  for (const entry of result.overdue.slice(0, MAX_LOGGED_TICK_ERRORS)) {
    logger.warn(`purchase report ${entry.id} (${entry.kind}) is overdue since ${entry.dueBy} after ${entry.attempts} attempts`);
  }
}

function describeError(error: unknown): string {
  if (isSubscriptionError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.name : 'unknown error';
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

export interface ServeOptions extends BuildServiceOptions {
  /** Defaults to `process.env`. */
  env?: EnvironmentVariables;
  /** Stop on SIGINT / SIGTERM. Default false here; the command line turns it on. */
  handleSignals?: boolean;
}

export interface RunningService {
  readonly service: Service;
  readonly server: RunningServer;
  /** `http://host:port` the service is reachable on. */
  readonly url: string;
  readonly port: number;
  /** Stops the tick loop, closes the server and the store. Safe to call twice. */
  stop(): Promise<void>;
  /** Resolves once the service has stopped, whatever stopped it. */
  readonly stopped: Promise<void>;
}

/**
 * Builds the service, starts listening, starts the tick loop (when the
 * scheduler is on), prints the startup report and, with `handleSignals`, stops
 * cleanly on SIGINT / SIGTERM. Rejects (after releasing everything it opened)
 * with the configuration error or the listen error.
 */
export async function runServe(options: ServeOptions = {}): Promise<RunningService> {
  const logger = options.logger ?? consoleLogger;
  const service = await buildService(options.env ?? process.env, { ...options, logger });

  let server: RunningServer;
  try {
    server = await listen(service.createServer(), { host: service.config.host, port: service.config.port });
  } catch (error) {
    await service.close();
    throw error;
  }

  // The reports owed to Google are flushed on the same tick; without the Google Play provider none are ever queued.
  const flushes = service.purchases !== undefined && service.client.providers.includes(Provider.GooglePlay);
  const loop =
    service.scheduler || flushes
      ? createTickLoop({
          scheduler: service.scheduler,
          purchases: flushes ? service.purchases : undefined,
          intervalMs: service.config.tickSeconds * MILLIS_PER_SECOND,
          logger,
        })
      : undefined;

  const handlers = new Map<NodeJS.Signals, () => void>();
  let stopping: Promise<void> | undefined;
  let markStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
      await loop?.stop();
      await server.close().catch(() => undefined);
      await service.close();
      markStopped();
    })();
    return stopping;
  };

  if (options.handleSignals) {
    for (const signal of SHUTDOWN_SIGNALS) {
      const handler = (): void => {
        logger.info(`received ${signal}, shutting down`);
        void stop();
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  for (const line of service.describe(server.url)) logger.info(line);
  for (const warning of service.config.warnings) logger.warn(warning);
  loop?.start();

  return { service, server, url: server.url, port: server.port, stop, stopped };
}
