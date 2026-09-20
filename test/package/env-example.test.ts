import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_TICK_SECONDS, EnvVar } from '../../src/service-config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lines = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n');

const assignments = lines
  .map((text, index) => ({ text, index }))
  .filter(({ text }) => /^[A-Z][A-Z0-9_]*=/.test(text));

/** The only variables that ship with a value: harmless defaults. */
const DEFAULTS: Record<string, string> = {
  [EnvVar.Host]: DEFAULT_HOST,
  [EnvVar.Port]: String(DEFAULT_PORT),
  [EnvVar.SchedulerTickSeconds]: String(DEFAULT_TICK_SECONDS),
};

describe('.env.example', () => {
  it('lists every variable the service reads, once, and no other', () => {
    expect(assignments.map(({ text }) => text.split('=')[0]).sort()).toEqual(Object.values(EnvVar).sort());
  });

  it('puts a one-line comment above every variable', () => {
    for (const { text, index } of assignments) {
      const previous = (lines[index - 1] ?? '').trim();
      expect(previous.startsWith('#') && previous.length > 2, `${text.split('=')[0]} needs a comment`).toBe(true);
    }
  });

  it('holds no real value: only empty assignments and the documented defaults', () => {
    for (const { text } of assignments) {
      const [name, ...rest] = text.split('=');
      const value = rest.join('=');
      expect(value === '' || value === DEFAULTS[name as string], `${name}=${value}`).toBe(true);
    }
  });

  it('is not ignored by git while real .env files are', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('.env');
    expect(ignore).toContain('!.env.example');
  });
});
