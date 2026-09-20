// Proves the package is consumable the way a user would consume it:
//   1. `npm run build` succeeds;
//   2. `npm pack --dry-run` lists only dist/, README.md, LICENSE and package.json;
//   3. the real tarball installs into a temp project OUTSIDE this repo;
//   4. every entry point imports (ESM) and requires (CJS), and typechecks for TypeScript users;
//   5. the main entry cannot reach node:http, the server or the browser code, and the
//      checkout entry's built files import no node: module;
//   6. the bin prints the OpenAPI document and `serve` starts, answers /v1/health and rejects
//      an unauthenticated request.
// No network is used: dependencies come from this repo's node_modules, packed to a tarball.
// Run it with `npm run check:package`; test/package/consumption.test.ts runs it in `npm test`.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = 'india-subscriptions';
const ALLOWED_TOP_LEVEL = new Set(['dist', 'README.md', 'LICENSE', 'package.json']);
const REQUIRED_FILES = [
  'dist/esm/index.js',
  'dist/esm/index.d.ts',
  'dist/esm/server-entry.js',
  'dist/esm/checkout/index.js',
  'dist/esm/bin.js',
  'dist/esm/package.json',
  'dist/cjs/index.js',
  'dist/cjs/index.d.ts',
  'dist/cjs/server-entry.js',
  'dist/cjs/checkout/index.js',
  'dist/cjs/package.json',
  'LICENSE',
  'package.json',
];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
const NODE_HTTP = new Set(['http', 'https', 'node:http', 'node:https', 'http2', 'node:http2']);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let stepNumber = 0;
const cleanup = [];

function step(name) {
  stepNumber += 1;
  console.log(`\n[${stepNumber}] ${name}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${result.status ?? result.signal})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

function isBuiltin(specifier) {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return specifier.startsWith('node:') || builtinModules.includes(bare) || builtinModules.includes(bare.split('/')[0]);
}

/** Every file reachable from `entry` through relative imports, with the bare/builtin specifiers each one uses. */
function importGraph(entry) {
  const files = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    if (!existsSync(file)) throw new Error(`${file} is imported but missing from the build`);
    const specifiers = [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((match) => match[1]);
    files.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
    }
  }
  return files;
}

function check(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`);
  console.log(`  ok  ${name}`);
}

try {
  // -------------------------------------------------------------------------
  step('npm run build');
  run(npm, ['run', 'build'], { cwd: ROOT });
  console.log('  ok  build succeeded');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  // -------------------------------------------------------------------------
  step('tarball contents (npm pack --dry-run)');
  const dry = JSON.parse(run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT }));
  const listed = dry[0].files.map((file) => file.path);
  const unexpected = listed.filter((path) => !ALLOWED_TOP_LEVEL.has(path.split('/')[0]));
  check('only dist, README.md, LICENSE and package.json are packed', unexpected.length === 0, unexpected.join(', '));
  const forbidden = listed.filter((path) => /(^|\/)(test|tests|docs|scripts|src|clients|openapi)\//.test(path) || /(^|\/)\.env/.test(path) || /fact/i.test(path));
  check('no tests, sources, docs, fact sheets or .env files', forbidden.length === 0, forbidden.join(', '));
  const missing = REQUIRED_FILES.filter((path) => !listed.includes(path));
  check('every entry point and the bin are in the tarball', missing.length === 0, missing.join(', '));
  if (!listed.includes('README.md')) console.warn('  WARNING: README.md does not exist, so the package ships without one');

  // -------------------------------------------------------------------------
  step('install the tarball into a project outside the repo');
  const work = mkdtempSync(join(tmpdir(), 'india-subscriptions-consumer-'));
  cleanup.push(() => rmSync(work, { recursive: true, force: true }));
  const tarballs = join(work, 'tarballs');
  mkdirSync(tarballs);
  const packed = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs], { cwd: ROOT }));
  const tarball = join(tarballs, packed[0].filename);
  // zod comes from this repo's node_modules, so the check works offline.
  const zodPacked = JSON.parse(
    run(npm, ['pack', join(ROOT, 'node_modules', 'zod'), '--json', '--ignore-scripts', '--pack-destination', tarballs]),
  );
  const zodTarball = join(tarballs, zodPacked[0].filename);

  const consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }));
  run(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tarball, zodTarball], { cwd: consumer });
  const installed = join(consumer, 'node_modules', PACKAGE_NAME);
  check('installed under node_modules', existsSync(join(installed, 'package.json')));
  check('the installed package has no src, test or .env', !['src', 'test', '.env'].some((name) => existsSync(join(installed, name))));
  const bin = join(consumer, 'node_modules', '.bin', PACKAGE_NAME);
  check('npm linked the bin', existsSync(bin));

  // -------------------------------------------------------------------------
  step('ESM and CJS imports through all three entry points');
  writeFileSync(
    join(consumer, 'esm.mjs'),
    `
import assert from 'node:assert/strict';
import * as main from '${PACKAGE_NAME}';
import * as server from '${PACKAGE_NAME}/server';
import * as checkout from '${PACKAGE_NAME}/checkout';
import pkg from '${PACKAGE_NAME}/package.json' with { type: 'json' };

assert.equal(typeof main.createSubscriptions, 'function');
const client = main.createSubscriptions({ providers: [main.razorpay({ keyId: 'rzp_test_x', keySecret: 'secret' })] });
assert.deepEqual(client.providers, ['razorpay']);
assert.equal(client.capabilities('razorpay').provider, 'razorpay');
assert.equal(typeof main.cashfree, 'function');
assert.equal(typeof main.payu, 'function');
assert.equal(typeof main.BillingScheduler, 'function');
assert.equal(typeof main.MemorySchedulerStore, 'function');
assert.equal(typeof main.RazorpayApi, 'object');
assert.equal(typeof main.CashfreeApi, 'object');
assert.equal(typeof main.PayUApi, 'object');
assert.equal(main.paiseToRupeeString(49900), '499.00');
assert.equal(main.rupeesToPaise('499.00'), 49900);
assert.equal(main.schemaRegistry.get(main.ProviderSchema)?.id, 'Provider', 'schemas are registered on import');
assert.throws(() => main.createSubscriptions({ providers: [] }), (e) => e instanceof main.SubscriptionError && e.code === 'CONFIG');
assert.equal('createHandler' in main, false, 'the main entry has no server');
assert.equal('openCheckout' in main, false, 'the main entry has no browser code');

assert.equal(typeof server.createHandler, 'function');
assert.equal(typeof server.FileSchedulerStore, 'function');
assert.equal(typeof server.runServe, 'function');
assert.equal(typeof server.buildOpenApiDocument, 'function');
assert.equal(typeof checkout.openCheckout, 'function');
assert.equal(pkg.name, '${PACKAGE_NAME}');
console.log('esm ok');
`,
  );
  console.log('  ' + run(process.execPath, ['esm.mjs'], { cwd: consumer }).trim());
  writeFileSync(
    join(consumer, 'cjs.cjs'),
    `
const assert = require('node:assert/strict');
const main = require('${PACKAGE_NAME}');
const server = require('${PACKAGE_NAME}/server');
const checkout = require('${PACKAGE_NAME}/checkout');

const client = main.createSubscriptions({ providers: [main.payu({ key: 'k', salt: 's', environment: 'test' })] });
assert.deepEqual(client.providers, ['payu']);
assert.equal(typeof main.cashfree, 'function');
assert.equal(typeof main.RazorpayApi, 'object');
assert.equal(main.schemaRegistry.get(main.ProviderSchema)?.id, 'Provider');
assert.ok(main.SubscriptionError.prototype instanceof Error);
assert.equal(typeof server.createNodeServer, 'function');
assert.equal(typeof server.FileSchedulerStore.open, 'function');
assert.equal(typeof checkout.openCheckout, 'function');
console.log('cjs ok');
`,
  );
  console.log('  ' + run(process.execPath, ['cjs.cjs'], { cwd: consumer }).trim());
  // A second, separate check that a CJS consumer sees one SubscriptionError class across entries.
  writeFileSync(
    join(consumer, 'cjs-identity.cjs'),
    `
const assert = require('node:assert/strict');
const main = require('${PACKAGE_NAME}');
const checkout = require('${PACKAGE_NAME}/checkout');
assert.equal(checkout.SubscriptionError, main.SubscriptionError);
console.log('cjs identity ok');
`,
  );
  console.log('  ' + run(process.execPath, ['cjs-identity.cjs'], { cwd: consumer }).trim());

  // -------------------------------------------------------------------------
  step('TypeScript consumers: types resolve for every entry point');
  mkdirSync(join(consumer, 'node_modules', '@types'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(consumer, 'node_modules', '@types', 'node'), 'dir');
  const typesSource = `
import { createSubscriptions, razorpay, RazorpayApi, CashfreeApi, PayUApi, SubscriptionError, ErrorCode, BaseProvider, type SubscriptionProvider, type Subscription, type SchedulerStore } from '${PACKAGE_NAME}';
import { FileSchedulerStore, createHandler, runServe } from '${PACKAGE_NAME}/server';
import { openCheckout, type CheckoutInstruction } from '${PACKAGE_NAME}/checkout';

const client = createSubscriptions({ providers: [razorpay({ keyId: 'a', keySecret: 'b' })] });
const status: Promise<Subscription> = client.get('razorpay', 'sub_1');
const code: ErrorCode = new SubscriptionError(ErrorCode.Config, 'x').code;
const store: Promise<SchedulerStore> = FileSchedulerStore.open('/tmp/x.json');
const handler = createHandler({ client, apiKey: 'k' });
const checkout: (i: CheckoutInstruction) => Promise<unknown> = (i) => openCheckout(i);
const custom: typeof BaseProvider | SubscriptionProvider | undefined = undefined;
void [status, code, store, handler, checkout, custom, runServe, RazorpayApi, CashfreeApi, PayUApi];
`;
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const typecheck = (label, file, flags) => {
    writeFileSync(join(consumer, file), typesSource);
    run(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', 'false', '--types', 'node', ...flags, file], { cwd: consumer });
    console.log(`  ok  ${label}`);
  };
  typecheck('NodeNext, ESM consumer (.mts)', 'types.mts', ['--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022']);
  typecheck('NodeNext, CJS consumer (.cts)', 'types.cts', ['--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022']);
  typecheck('legacy node10 resolution (typesVersions)', 'types-legacy.ts', ['--module', 'commonjs', '--moduleResolution', 'node10', '--esModuleInterop', '--target', 'es2022']);
  typecheck('bundler resolution', 'types-bundler.ts', ['--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022']);

  // -------------------------------------------------------------------------
  step('entry points stay in their lane');
  for (const flavour of ['esm', 'cjs']) {
    const main = importGraph(join(installed, 'dist', flavour, 'index.js'));
    const names = [...main.keys()].map((file) => file.slice(installed.length + 1));
    const httpUsers = [...main].filter(([, specifiers]) => specifiers.some((s) => NODE_HTTP.has(s))).map(([file]) => file);
    check(`${flavour}: the main entry never imports node:http`, httpUsers.length === 0, httpUsers.join(', '));
    const strays = names.filter((name) => /\/(server|checkout)\//.test(name) || /\/(server-entry|cli|bin|service|service-config|scheduler-file-store)\.js$/.test(name));
    check(`${flavour}: the main entry reaches no server, CLI, file-store or browser module`, strays.length === 0, strays.join(', '));

    const browser = importGraph(join(installed, 'dist', flavour, 'checkout', 'index.js'));
    const nodeImports = [...browser].flatMap(([file, specifiers]) => specifiers.filter(isBuiltin).map((s) => `${file.slice(installed.length + 1)} -> ${s}`));
    check(`${flavour}: the checkout entry imports no node: module`, nodeImports.length === 0, nodeImports.join(', '));
    const nodeOnly = [...browser.keys()].map((f) => f.slice(installed.length + 1)).filter((name) => /\/(crypto|http)\.js$/.test(name));
    check(`${flavour}: the checkout entry does not reach crypto.js or http.js`, nodeOnly.length === 0, nodeOnly.join(', '));
  }

  // -------------------------------------------------------------------------
  step('the bin: openapi');
  const openapi = spawnSync(bin, ['openapi'], { cwd: consumer, encoding: 'utf8' });
  check('exits 0', openapi.status === 0, `${openapi.status} ${openapi.stderr}`);
  const document = JSON.parse(openapi.stdout);
  check('prints a valid OpenAPI 3.1 JSON document', /^3\.1/.test(document.openapi) && Object.keys(document.paths).includes('/v1/health'));
  check('with the package version', document.info.version === pkg.version);
  const version = spawnSync(bin, ['--version'], { cwd: consumer, encoding: 'utf8' });
  check('--version prints the package version', version.stdout.trim() === pkg.version);

  // -------------------------------------------------------------------------
  step('the bin: serve');
  const noConfig = spawnSync(bin, ['serve'], { cwd: consumer, encoding: 'utf8', env: { PATH: process.env.PATH } });
  check('refuses to start without configuration (exit 2, message, no stack)', noConfig.status === 2 && /Invalid configuration/.test(noConfig.stderr) && !/\n\s+at /.test(noConfig.stderr));

  const secrets = { apiKey: 'check-package-api-key-0123456789', razorpay: 'check-package-razorpay-secret' };
  const storeFile = join(work, 'state', 'scheduler.json');
  const child = spawn(bin, ['serve'], {
    cwd: consumer,
    env: {
      PATH: process.env.PATH,
      INDIA_SUBSCRIPTIONS_API_KEY: secrets.apiKey,
      PORT: '0',
      RAZORPAY_KEY_ID: 'rzp_test_fake',
      RAZORPAY_KEY_SECRET: secrets.razorpay,
      RAZORPAY_WEBHOOK_SECRET: 'fake-webhook-secret',
      SCHEDULER_STORE_FILE: storeFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (err += chunk));
  const exited = new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code)));
  cleanup.push(() => child.kill('SIGKILL'));
  const deadline = Date.now() + 20_000;
  while (!/listening on http:\/\/\S+/.test(out)) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`serve did not start\n${out}\n${err}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const url = /listening on (http:\/\/\S+)/.exec(out)[1];
  check('prints the listen URL', true, url);
  check('prints which gateways are enabled and the scheduler state', /gateways enabled: razorpay/.test(out) && /billing scheduler: on/.test(out));

  const health = await fetch(`${url}/v1/health`);
  check('GET /v1/health answers 200', health.status === 200);
  check('health lists the configured gateway', JSON.stringify(await health.json()) === JSON.stringify({ status: 'ok', providers: ['razorpay'] }));
  const unauthenticated = await fetch(`${url}/v1/providers`);
  check('an unauthenticated request is rejected (401)', unauthenticated.status === 401);
  const wrongKey = await fetch(`${url}/v1/providers`, { headers: { authorization: 'Bearer wrong' } });
  check('a wrong key is rejected (401)', wrongKey.status === 401);
  const authorised = await fetch(`${url}/v1/providers`, { headers: { authorization: `Bearer ${secrets.apiKey}` } });
  check('the API key is accepted', authorised.status === 200);
  check('the scheduler store file was created', existsSync(storeFile));
  if (process.platform !== 'win32') check('with mode 0600', (statSync(storeFile).mode & 0o777) === 0o600);

  child.kill('SIGTERM');
  const code = await exited;
  check('SIGTERM stops it cleanly (exit 0)', code === 0, String(code));
  check('startup output never contains a secret', ![secrets.apiKey, secrets.razorpay, 'fake-webhook-secret'].some((secret) => out.includes(secret) || err.includes(secret)));

  console.log('\ncheck-package: OK');
} catch (error) {
  console.error(`\ncheck-package: FAILED\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  for (const fn of cleanup.reverse()) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
}
