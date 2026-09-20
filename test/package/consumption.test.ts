import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Runs scripts/check-package.mjs: build, `npm pack`, install the tarball into a
 * temp project outside the repo, import and require all three entry points,
 * typecheck them, run the bin (`openapi`, `serve`) and check the tarball and
 * the browser entry. It rebuilds `dist/`, so it is the only test that does.
 */
describe('package consumption', () => {
  it(
    'builds, packs, installs and runs the package the way a user would',
    () => {
      const result = spawnSync(process.execPath, [join(ROOT, 'scripts/check-package.mjs')], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: FIVE_MINUTES,
        // Do not inherit the test runner's npm settings or NODE_OPTIONS.
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      });
      const report = `${result.stdout}\n${result.stderr}`;
      expect(result.status, report).toBe(0);
      expect(result.stdout).toContain('check-package: OK');
      for (const proof of [
        'only dist, README.md, LICENSE and package.json are packed',
        'esm ok',
        'cjs ok',
        'the main entry never imports node:http',
        'the checkout entry imports no node: module',
        'GET /v1/health answers 200',
        'an unauthenticated request is rejected (401)',
      ]) {
        expect(result.stdout, proof).toContain(proof);
      }
    },
    FIVE_MINUTES,
  );
});
