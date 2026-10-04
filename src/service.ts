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
import { cashfree } from './providers/cashfree/index.js';
import { payu } from './providers/payu/index.js';
import { paytm } from './providers/paytm/index.js';
import { phonepe } from './providers/phonepe/index.js';
import { razorpay } from './providers/razorpay/index.js';
import { BillingScheduler } from './scheduler/scheduler.js';
import type { TickResult } from './scheduler/schemas.js';
import { FileSchedulerStore } from './scheduler-file-store.js';
import { createNodeServer, listen, type RunningServer } from './server/node.js';
import type { EventsHook } from './server/routes.js';
import {
  GATEWAY_ORDER,
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

  let client: Subscriptions;
  try {
    client = createSubscriptions({ providers, scheduler });
  } catch (error) {
    await schedulerEvents?.close();
    await store?.close();
    throw error;
  }

  const onEvents = eventsWebhook ? createEventsForwarder({ ...eventsWebhook, fetch: options.fetch }) : undefined;

  return {
    config,
    client,
    scheduler,
    store,
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
    },
  };
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
  const lines = [
    `${PACKAGE_NAME} ${PACKAGE_VERSION}`,
    `gateways enabled: ${enabled.join(', ')}`,
    `listening on ${listenUrl}`,
  ];
  if (config.schedulerStoreFile) {
    lines.push(`billing scheduler: on (store ${config.schedulerStoreFile}, tick every ${config.tickSeconds}s)`);
  } else {
    const consequence = schedulerConsequence(enabled, client);
    lines.push(`billing scheduler: OFF (${EnvVar.SchedulerStoreFile} is not set; ${consequence})`);
  }
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

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

export interface TickLoopOptions {
  scheduler: Pick<BillingScheduler, 'tick'>;
  intervalMs: number;
  logger?: Logger;
}

export interface TickLoop {
  /** Starts ticking: once now, then every interval. Idempotent. */
  start(): void;
  /** Stops scheduling and waits for a tick in flight to finish. */
  stop(): Promise<void>;
  /** One tick now. Resolves `undefined` (and logs) when it failed or another tick is still running. */
  runOnce(): Promise<TickResult | undefined>;
}

/**
 * Calls `scheduler.tick()` on an interval, never overlapping itself: a tick
 * that is still running makes the next interval skip. A failing tick is logged,
 * never thrown, and the loop carries on.
 */
export function createTickLoop(options: TickLoopOptions): TickLoop {
  const logger = options.logger ?? consoleLogger;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<TickResult | undefined> | undefined;
  let stopped = false;

  async function tickOnce(): Promise<TickResult | undefined> {
    try {
      const result = await options.scheduler.tick();
      logTick(logger, result);
      return result;
    } catch (error) {
      logger.error(`scheduler tick failed: ${describeError(error)}`);
      return undefined;
    }
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

  const loop = service.scheduler
    ? createTickLoop({ scheduler: service.scheduler, intervalMs: service.config.tickSeconds * MILLIS_PER_SECOND, logger })
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
