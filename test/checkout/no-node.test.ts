import { builtinModules } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHECKOUT_DIR = join(ROOT, 'src/checkout');

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const NODE_GLOBALS = /\b(?:process\.|Buffer\.|__dirname|__filename|require\()/;

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map((m) => m[1] ?? m[2] ?? '');
}

function isNodeBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return specifier.startsWith('node:') || builtinModules.includes(bare) || builtinModules.includes(bare.split('/')[0] ?? '');
}

function resolveRelative(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier.replace(/\.js$/, '.ts'));
  if (!existsSync(target)) throw new Error(`${from} imports ${specifier}, which does not exist`);
  return target;
}

/** Every source file reachable from src/checkout (relative imports only; zod is the one npm dependency). */
function closure(): string[] {
  const queue = readdirSync(CHECKOUT_DIR).filter((f) => f.endsWith('.ts')).map((f) => join(CHECKOUT_DIR, f));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(resolveRelative(file, spec));
    }
  }
  return [...seen].sort();
}

describe('browser safety', () => {
  const files = closure();

  it('covers the checkout files and the shared modules they use', () => {
    const names = files.map((f) => f.slice(ROOT.length + 1));
    expect(names).toEqual(expect.arrayContaining(['src/checkout/index.ts', 'src/errors.ts', 'src/schemas.ts', 'src/constants.ts']));
  });

  it('never imports crypto.ts or http.ts, which pull in Node', () => {
    const names = files.map((f) => f.slice(ROOT.length + 1));
    expect(names).not.toContain('src/crypto.ts');
    expect(names).not.toContain('src/http.ts');
  });

  it.each(files.map((f) => [f.slice(ROOT.length + 1), f] as const))('%s imports no Node built-in and uses no Node globals', (_name, file) => {
    const source = readFileSync(file, 'utf8');
    const offenders = specifiers(source).filter(isNodeBuiltin);
    expect(offenders).toEqual([]);
    expect(source).not.toMatch(NODE_GLOBALS);
  });

  it('only depends on zod outside the repo', () => {
    const bare = new Set<string>();
    for (const file of files) for (const spec of specifiers(readFileSync(file, 'utf8'))) if (!spec.startsWith('.')) bare.add(spec);
    expect([...bare]).toEqual(['zod']);
  });
});
