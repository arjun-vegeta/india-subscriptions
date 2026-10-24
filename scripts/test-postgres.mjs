// Runs the PostgreSQL tests (test/postgres) against a throwaway PostgreSQL container.
//
//   npm run test:postgres [-- --runs=3] [-- vitest arguments, for example a file name]
//
// It starts the official `postgres` image as a container named `ffu4-pg-<pid>-<random>` whose data directory is a
// tmpfs, on a free port bound to 127.0.0.1 only, waits until the server accepts connections over TCP, runs vitest
// with TEST_DATABASE_URL set, and ALWAYS removes the container afterwards (normal exit, test failure, Ctrl-C, SIGTERM).
// Needs Docker running. Override the image with TEST_POSTGRES_IMAGE.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.TEST_POSTGRES_IMAGE ?? 'postgres:16-alpine';
const CONTAINER_PREFIX = 'ffu4-pg-';
const CONTAINER_PORT = 5432;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 250;
const TEST_DIRECTORY = 'test/postgres';
const RUNS_FLAG = /^--runs=(\d+)$/;

const container = `${CONTAINER_PREFIX}${process.pid}-${randomBytes(3).toString('hex')}`;
const password = randomBytes(16).toString('hex');
let started = false;
let removed = false;

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...options });
}

function removeContainer() {
  if (!started || removed) return;
  removed = true;
  const result = docker(['rm', '--force', '--volumes', container]);
  if (result.status === 0) console.log(`[test:postgres] removed container ${container}`);
  else console.error(`[test:postgres] could not remove container ${container}: ${result.stderr.trim()}`);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    removeContainer();
    process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[signal]);
  });
}
process.on('exit', removeContainer);

async function waitUntilReady(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    const state = docker(['inspect', '--format', '{{.State.Running}}', container]);
    if (state.status !== 0 || state.stdout.trim() !== 'true') {
      throw new Error(`the container stopped before it was ready:\n${docker(['logs', '--tail', '40', container]).stdout}`);
    }
    // The image first runs a temporary server that does not listen on TCP; a TCP connection that works is the real one.
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await client.end().catch(() => undefined);
      await new Promise((done) => setTimeout(done, READY_POLL_MS));
    }
  }
  throw new Error(`PostgreSQL did not accept connections within ${READY_TIMEOUT_MS / 1000}s (${lastError})`);
}

function runVitest(url, args) {
  return new Promise((done) => {
    const child = spawn('npx', ['vitest', 'run', TEST_DIRECTORY, ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, TEST_DATABASE_URL: url },
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
    child.on('error', () => done(1));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const runsArg = argv.map((arg) => RUNS_FLAG.exec(arg)).find(Boolean);
  const runs = runsArg ? Number(runsArg[1]) : 1;
  const vitestArgs = argv.filter((arg) => !RUNS_FLAG.test(arg));

  const info = docker(['info', '--format', '{{.ServerVersion}}']);
  if (info.error || info.status !== 0) {
    console.error('[test:postgres] Docker is not available. Start Docker and try again.');
    return 1;
  }

  console.log(`[test:postgres] starting ${container} from ${IMAGE}`);
  // `-p 127.0.0.1::5432` lets Docker pick a free host port, bound to the loopback interface only.
  const run = docker([
    'run', '--detach', '--name', container,
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--publish', `127.0.0.1::${CONTAINER_PORT}`,
    '--tmpfs', '/var/lib/postgresql',
    IMAGE,
    '-c', 'max_connections=300', '-c', 'fsync=off',
  ]);
  started = run.status === 0 || docker(['inspect', container]).status === 0;
  if (run.status !== 0) {
    console.error(`[test:postgres] could not start the container:\n${run.stderr}`);
    return 1;
  }

  const port = /:(\d+)\s*$/m.exec(docker(['port', container, `${CONTAINER_PORT}/tcp`]).stdout)?.[1];
  if (!port) {
    console.error('[test:postgres] could not find the published port');
    return 1;
  }
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  await waitUntilReady(url);
  console.log(`[test:postgres] PostgreSQL is accepting connections on 127.0.0.1:${port}`);

  for (let attempt = 1; attempt <= runs; attempt += 1) {
    if (runs > 1) console.log(`\n[test:postgres] run ${attempt} of ${runs}`);
    const code = await runVitest(url, vitestArgs);
    if (code !== 0) return code;
  }
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`[test:postgres] ${error instanceof Error ? error.message : String(error)}`);
} finally {
  removeContainer();
}
process.exit(exitCode);
