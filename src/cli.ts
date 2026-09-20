/**
 * The `india-subscriptions` command: `serve` runs the HTTP service from
 * environment variables, `openapi` prints the service's OpenAPI document.
 * `runCli` takes its streams and environment as arguments so it can be tested
 * in-process; `bin.ts` wires it to the real process.
 */
import { parseArgs } from 'node:util';
import { isSubscriptionError } from './errors.js';
import { buildOpenApiDocument } from './server/openapi.js';
import { ErrorCode } from './constants.js';
import { createStreamLogger, runServe, type RunningService } from './service.js';
import { EnvVar, type EnvironmentVariables } from './service-config.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

export const Command = {
  Serve: 'serve',
  OpenApi: 'openapi',
} as const;
export type Command = (typeof Command)[keyof typeof Command];

export const ExitCode = {
  Ok: 0,
  /** The command ran and failed (could not listen, could not open the store, ...). */
  Failure: 1,
  /** Bad usage or bad configuration: nothing was started. */
  Usage: 2,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

const Flag = {
  Help: 'help',
  Version: 'version',
  AllowUnauthenticated: 'allow-unauthenticated',
  ServerUrl: 'server-url',
} as const;
type Flag = (typeof Flag)[keyof typeof Flag];

const JSON_INDENT = 2;

export const USAGE = `${PACKAGE_NAME} ${PACKAGE_VERSION}

Usage:
  ${PACKAGE_NAME} serve [--allow-unauthenticated]
  ${PACKAGE_NAME} openapi [--server-url <url>]
  ${PACKAGE_NAME} --help | --version

Commands:
  serve     Run the HTTP service (OpenAPI at /v1/openapi.json). Configured only
            through environment variables; see .env.example in the package.
  openapi   Print the service's OpenAPI 3.1 document as JSON and exit.

Options:
  --allow-unauthenticated   serve: accept requests without an API key. Without
                            it ${EnvVar.ApiKey} is required.
  --server-url <url>        openapi: where the API is mounted (default "/").
  -h, --help                Show this help.
  -v, --version             Show the version.

Environment (serve):
  ${EnvVar.ApiKey}   bearer token clients must send
  ${EnvVar.Host}, ${EnvVar.Port}                   listen address (default 127.0.0.1:8787)
  Gateways, each enabled by its variables (a half-set gateway is an error):
    ${EnvVar.RazorpayKeyId} ${EnvVar.RazorpayKeySecret} [${EnvVar.RazorpayWebhookSecret}]
    ${EnvVar.CashfreeClientId} ${EnvVar.CashfreeClientSecret} ${EnvVar.CashfreeEnvironment} [${EnvVar.CashfreeWebhookSecret}]
    ${EnvVar.PayuKey} ${EnvVar.PayuSalt} ${EnvVar.PayuEnvironment} [${EnvVar.PayuSuccessUrl} ${EnvVar.PayuFailureUrl}]
  ${EnvVar.SchedulerStoreFile}, ${EnvVar.SchedulerTickSeconds}   billing scheduler (off without a store file)
  ${EnvVar.EventsWebhookUrl}, ${EnvVar.EventsWebhookSecret}   forward gateway events, signed
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: EnvironmentVariables;
  /** Called once `serve` is listening (tests use it to stop the service). */
  onServing?: (running: RunningService) => void;
  /** Stop `serve` on SIGINT / SIGTERM. The real command line sets it. */
  handleSignals?: boolean;
}

/** Runs the command and resolves with its exit code. `serve` resolves only once the service has stopped. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`${PACKAGE_NAME}: ${error instanceof Error ? error.message : 'invalid arguments'}\n\n${USAGE}`);
    return ExitCode.Usage;
  }
  const { values, positionals } = parsed;

  if (values[Flag.Help]) {
    io.stdout(USAGE);
    return ExitCode.Ok;
  }
  if (values[Flag.Version]) {
    io.stdout(`${PACKAGE_VERSION}\n`);
    return ExitCode.Ok;
  }

  const [command, ...extra] = positionals;
  if (command === undefined) {
    io.stderr(`${PACKAGE_NAME}: a command is required\n\n${USAGE}`);
    return ExitCode.Usage;
  }
  if (extra.length > 0) {
    io.stderr(`${PACKAGE_NAME}: unexpected argument ${JSON.stringify(extra[0])}\n\n${USAGE}`);
    return ExitCode.Usage;
  }

  switch (command) {
    case Command.OpenApi:
      return openapi(values, io);
    case Command.Serve:
      return serve(values, io);
    default:
      io.stderr(`${PACKAGE_NAME}: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return ExitCode.Usage;
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      [Flag.Help]: { type: 'boolean', short: 'h' },
      [Flag.Version]: { type: 'boolean', short: 'v' },
      [Flag.AllowUnauthenticated]: { type: 'boolean' },
      [Flag.ServerUrl]: { type: 'string' },
    },
  });
}

type Values = ReturnType<typeof parse>['values'];

function misplaced(values: Values, allowed: readonly Flag[], command: Command, io: CliIo): boolean {
  for (const flag of [Flag.AllowUnauthenticated, Flag.ServerUrl] as const) {
    if (values[flag] !== undefined && !allowed.includes(flag)) {
      io.stderr(`${PACKAGE_NAME}: --${flag} does not apply to ${command}\n\n${USAGE}`);
      return true;
    }
  }
  return false;
}

function openapi(values: Values, io: CliIo): ExitCode {
  if (misplaced(values, [Flag.ServerUrl], Command.OpenApi, io)) return ExitCode.Usage;
  const document = buildOpenApiDocument({ version: PACKAGE_VERSION, serverUrl: values[Flag.ServerUrl] });
  io.stdout(`${JSON.stringify(document, null, JSON_INDENT)}\n`);
  return ExitCode.Ok;
}

async function serve(values: Values, io: CliIo): Promise<ExitCode> {
  if (misplaced(values, [Flag.AllowUnauthenticated], Command.Serve, io)) return ExitCode.Usage;
  try {
    const running = await runServe({
      env: io.env,
      allowUnauthenticated: values[Flag.AllowUnauthenticated] === true,
      logger: createStreamLogger(io.stdout, io.stderr),
      handleSignals: io.handleSignals,
    });
    io.onServing?.(running);
    await running.stopped;
    return ExitCode.Ok;
  } catch (error) {
    if (isSubscriptionError(error)) {
      io.stderr(`${PACKAGE_NAME}: ${error.message}\n`);
      return error.code === ErrorCode.Config ? ExitCode.Usage : ExitCode.Failure;
    }
    // Node's listen errors (EADDRINUSE, EACCES) name the address, never a secret.
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
    const message = error instanceof Error ? error.message : 'unknown failure';
    io.stderr(`${PACKAGE_NAME}: could not start${code ? ` (${code})` : ''}: ${message}\n`);
    return ExitCode.Failure;
  }
}
