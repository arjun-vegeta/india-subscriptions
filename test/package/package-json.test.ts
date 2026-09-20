import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../src/version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  type: string;
  main: string;
  module: string;
  types: string;
  sideEffects: boolean | string[];
  exports: Record<string, unknown>;
  typesVersions?: Record<string, Record<string, string[]>>;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

/** `./dist/esm/checkout/index.js` -> `src/checkout/index.ts` */
function sourceOf(distPath: string): string {
  const match = /^\.\/dist\/(esm|cjs)\/(.+)\.(js|d\.ts)$/.exec(distPath);
  if (!match) throw new Error(`${distPath} is not a dist path`);
  return `src/${match[2]}.ts`;
}

const ENTRY_POINTS = [
  ['.', 'src/index.ts'],
  ['./server', 'src/server-entry.ts'],
  ['./checkout', 'src/checkout/index.ts'],
] as const;

describe('package.json', () => {
  it('names and versions match the code', () => {
    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(pkg.version).toBe(PACKAGE_VERSION);
  });

  it('is ESM at the root, with each build folder declaring its own module type in the build script', () => {
    expect(pkg.type).toBe('module');
    const build = readFileSync(join(ROOT, 'scripts/build.mjs'), 'utf8');
    expect(build).toContain("dist/cjs/package.json");
    expect(build).toContain("dist/esm/package.json");
  });

  it.each(ENTRY_POINTS)('exports %s with ESM, CJS and types, matching the build layout', (key, source) => {
    const entry = pkg.exports[key] as Record<'import' | 'require', { types: string; default: string }>;
    expect(Object.keys(entry).sort()).toEqual(['import', 'require']);
    for (const condition of ['import', 'require'] as const) {
      const target = entry[condition];
      // `types` comes first: TypeScript takes the first matching key.
      expect(Object.keys(target)).toEqual(['types', 'default']);
      const flavour = condition === 'import' ? 'esm' : 'cjs';
      expect(target.default).toBe(`./dist/${flavour}/${source.replace(/^src\//, '').replace(/\.ts$/, '.js')}`);
      expect(target.types).toBe(target.default.replace(/\.js$/, '.d.ts'));
      expect(existsSync(join(ROOT, sourceOf(target.default)))).toBe(true);
      expect(sourceOf(target.default)).toBe(source);
    }
  });

  it('exposes nothing else (no deep imports), apart from package.json', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './checkout', './package.json', './server']);
  });

  it('keeps the legacy fields in step with the "." entry, and typesVersions for old resolution of the subpaths', () => {
    expect(pkg.main).toBe('./dist/cjs/index.js');
    expect(pkg.module).toBe('./dist/esm/index.js');
    expect(pkg.types).toBe('./dist/cjs/index.d.ts');
    expect(pkg.typesVersions?.['*']).toEqual({
      server: ['dist/cjs/server-entry.d.ts'],
      checkout: ['dist/cjs/checkout/index.d.ts'],
    });
  });

  it('declares the bin, which has a shebang', () => {
    expect(pkg.bin).toEqual({ [PACKAGE_NAME]: './dist/esm/bin.js' });
    const source = readFileSync(join(ROOT, sourceOf(pkg.bin[PACKAGE_NAME] as string)), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('ships only dist, the README and the license', () => {
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });

  it('has exactly one runtime dependency', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['zod']);
  });

  it('has the build and check scripts', () => {
    expect(pkg.scripts.build).toBe('node scripts/build.mjs');
    expect(pkg.scripts['check:package']).toBe('node scripts/check-package.mjs');
  });

  describe('sideEffects', () => {
    const listed = Array.isArray(pkg.sideEffects) ? pkg.sideEffects : [];

    /** Source files that register something in a shared registry (heuristic: a registry `.add(` call or `z.config(`), which happens when they are imported. */
    function registering(): string[] {
      const found: string[] = [];
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
          const path = join(directory, entry);
          if (statSync(path).isDirectory()) walk(path);
          else if (path.endsWith('.ts') && /\b[A-Za-z]*[Rr]egistry\.(?:add|register)\(|\bz\.config\(/.test(readFileSync(path, 'utf8'))) {
            found.push(path.slice(ROOT.length + 1));
          }
        }
      };
      walk(join(ROOT, 'src'));
      return found.sort();
    }

    it('is not blanket false: the schema registry registers schemas at import', () => {
      expect(pkg.sideEffects).not.toBe(false);
      expect(Array.isArray(pkg.sideEffects)).toBe(true);
    });

    it('lists every module that registers at import, in both builds, and nothing that does not exist', () => {
      const modules = registering();
      expect(modules).toEqual(['src/schema-registry.ts']);
      for (const module of modules) {
        const stem = module.replace(/^src\//, '').replace(/\.ts$/, '.js');
        expect(listed).toContain(`./dist/esm/${stem}`);
        expect(listed).toContain(`./dist/cjs/${stem}`);
      }
      expect(listed).toHaveLength(modules.length * 2);
    });
  });
});
