import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Command, ExitCode, USAGE, runCli, type CliIo } from '../../src/cli.js';
import { EnvVar, type EnvironmentVariables } from '../../src/service-config.js';
import type { RunningService } from '../../src/service.js';
import { PACKAGE_VERSION } from '../../src/version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API_KEY = 'cli-test-api-key-0123456789';
const RAZORPAY_SECRET = 'cli-razorpay-secret-value';
const env: EnvironmentVariables = {
  [EnvVar.ApiKey]: API_KEY,
  [EnvVar.Port]: '0',
  [EnvVar.RazorpayKeyId]: 'rzp_test_id',
  [EnvVar.RazorpayKeySecret]: RAZORPAY_SECRET,
};

function harness(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), env, ...overrides };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('runCli', () => {
  it('prints help', async () => {
    for (const flag of ['--help', '-h']) {
      const h = harness();
      expect(await runCli([flag], h.io)).toBe(ExitCode.Ok);
      expect(h.stdout()).toBe(USAGE);
    }
    expect(USAGE).toContain('serve');
    expect(USAGE).toContain('openapi');
    expect(USAGE).toContain('--allow-unauthenticated');
  });

  it('prints the version', async () => {
    const h = harness();
    expect(await runCli(['--version'], h.io)).toBe(ExitCode.Ok);
    expect(h.stdout()).toBe(`${PACKAGE_VERSION}\n`);
  });

  it.each([
    [[], 'a command is required'],
    [['launch'], 'unknown command'],
    [['serve', 'extra'], 'unexpected argument'],
    [['serve', '--bogus'], 'bogus'],
    [['openapi', '--allow-unauthenticated'], 'does not apply to openapi'],
    [['serve', '--server-url', 'http://x'], 'does not apply to serve'],
    [['openapi', '--server-url'], 'server-url'],
  ])('rejects %j as a usage error', async (argv, message) => {
    const h = harness();
    expect(await runCli(argv, h.io)).toBe(ExitCode.Usage);
    expect(h.stdout()).toBe('');
    expect(h.stderr()).toContain(message);
    expect(h.stderr()).toContain('Usage:');
  });

  describe(Command.OpenApi, () => {
    it('prints the OpenAPI document as JSON and nothing else', async () => {
      const h = harness();
      expect(await runCli(['openapi'], h.io)).toBe(ExitCode.Ok);
      const document = JSON.parse(h.stdout());
      expect(document.openapi).toMatch(/^3\.1/);
      expect(document.info.version).toBe(PACKAGE_VERSION);
      expect(Object.keys(document.paths)).toContain('/v1/health');
      expect(h.stdout().endsWith('\n')).toBe(true);
      expect(h.stderr()).toBe('');
    });

    it('needs no environment', async () => {
      const h = harness({ env: {} });
      expect(await runCli(['openapi'], h.io)).toBe(ExitCode.Ok);
    });

    it('takes --server-url', async () => {
      const h = harness();
      await runCli(['openapi', '--server-url', 'https://billing.example.com'], h.io);
      expect(JSON.parse(h.stdout()).servers).toEqual([{ url: 'https://billing.example.com' }]);
    });
  });

  describe(Command.Serve, () => {
    it('refuses to start without configuration, with a clear message and exit code 2', async () => {
      const h = harness({ env: {} });
      expect(await runCli(['serve'], h.io)).toBe(ExitCode.Usage);
      expect(h.stdout()).toBe('');
      expect(h.stderr()).toContain('Invalid configuration');
      expect(h.stderr()).toContain(EnvVar.ApiKey);
      expect(h.stderr()).toContain('No payment gateway or app store is configured');
    });

    it('refuses a half-configured gateway', async () => {
      const h = harness({ env: { [EnvVar.ApiKey]: API_KEY, [EnvVar.PayuKey]: 'k' } });
      expect(await runCli(['serve'], h.io)).toBe(ExitCode.Usage);
      expect(h.stderr()).toContain(`${EnvVar.PayuSalt}: is required`);
    });

    it('--allow-unauthenticated replaces the API key', async () => {
      const without = { ...env };
      delete without[EnvVar.ApiKey];
      let serving: RunningService | undefined;
      const h = harness({ env: without, onServing: (r) => void (serving = r) });
      const exit = runCli(['serve', '--allow-unauthenticated'], h.io);
      await waitFor(() => serving !== undefined);
      expect((await fetch(`${serving!.url}/v1/providers`)).status).toBe(200);
      await serving!.stop();
      expect(await exit).toBe(ExitCode.Ok);
    });

    it('serves until stopped, then exits 0; the startup report holds no secret', async () => {
      let serving: RunningService | undefined;
      const h = harness({ onServing: (r) => void (serving = r) });
      const exit = runCli(['serve'], h.io);
      await waitFor(() => serving !== undefined);
      expect((await fetch(`${serving!.url}/v1/health`)).status).toBe(200);
      expect((await fetch(`${serving!.url}/v1/providers`)).status).toBe(401);
      await serving!.stop();
      expect(await exit).toBe(ExitCode.Ok);
      expect(h.stdout()).toContain('gateways enabled: razorpay');
      expect(h.stdout()).toContain(`listening on ${serving!.url}`);
      expect(h.stdout()).toContain('billing scheduler: OFF');
      for (const secret of [API_KEY, RAZORPAY_SECRET]) {
        expect(h.stdout()).not.toContain(secret);
        expect(h.stderr()).not.toContain(secret);
      }
    });

    it('exits 1 when the port is taken', async () => {
      const blocker = createServer();
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = blocker.address() as { port: number };
        const h = harness({ env: { ...env, [EnvVar.Port]: String(port) } });
        expect(await runCli(['serve'], h.io)).toBe(ExitCode.Failure);
        expect(h.stderr()).toContain('EADDRINUSE');
        expect(h.stderr()).not.toContain(RAZORPAY_SECRET);
      } finally {
        await new Promise((resolve) => blocker.close(resolve));
      }
    });
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the process: signals and exit codes', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  /** Runs the real entry point (`src/bin.ts`) in a child process through tsx. */
  function start(): { child: ChildProcess; output: () => string; errors: () => string; exited: Promise<number | null> } {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(ROOT, 'src/bin.ts'), 'serve'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', ...env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => void (out += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => void (err += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, output: () => out, errors: () => err, exited };
  }

  it.each(['SIGTERM', 'SIGINT'] as const)('shuts down cleanly on %s with exit code 0', async (signal) => {
    const run = start();
    await waitFor(() => run.output().includes('listening on'), 20_000);
    const url = /listening on (http:\/\/\S+)/.exec(run.output())?.[1] as string;
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);

    run.child.kill(signal);
    expect(await run.exited).toBe(0);
    expect(run.output()).toContain(`received ${signal}`);
    expect(run.errors()).not.toContain(RAZORPAY_SECRET);
    await expect(fetch(`${url}/v1/health`)).rejects.toThrow();
  }, 30_000);

  it('exits 2 with a message and no stack trace on a bad environment', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(ROOT, 'src/bin.ts'), 'serve'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '' } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => void (err += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(2);
    expect(err).toContain('Invalid configuration');
    expect(err).not.toContain('    at ');
  }, 30_000);

  it('has the shebang the bin entry needs', () => {
    expect(readFileSync(resolve(ROOT, 'src/bin.ts'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
