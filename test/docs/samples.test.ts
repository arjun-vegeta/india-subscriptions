/**
 * Every code sample in the documentation is checked here.
 *
 * - `ts` fences are type-checked against the real entry points (`india-subscriptions`, `/server`, `/checkout`, `/postgres`), in one
 *   virtual project, so a sample can import another by its title. A fence marked `ts fragment` is the counted exception.
 * - `ts` fences use the exported constants: no string literal may equal the value of a constant.
 * - `bash` fences hold one command and no `$` prompt; `json` fences parse; `python` fences compile and import from the
 *   real client; every fence names its language.
 * The samples that are also executed are in flows.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as CheckoutConstants from '../../src/checkout/constants.js';
import * as Constants from '../../src/constants.js';
import * as SchedulerConstants from '../../src/scheduler/constants.js';
import { ALLOWED_LANGUAGES, MAX_TS_FRAGMENTS, ROOT, allBlocks } from './lib.js';
import { isFragment, tsBlocks, typeCheck, virtualFiles } from './typescript-blocks.js';

const blocks = allBlocks();

describe('code fences', () => {
  it('name their language, and only use languages the site can render', () => {
    const problems = blocks
      .filter((block) => !(ALLOWED_LANGUAGES as readonly string[]).includes(block.lang))
      .map((block) => `${block.page}:${block.line}: fence language "${block.lang}"`);
    expect(problems).toEqual([]);
  });

  it('keeps the number of uncompiled ts fragments small', () => {
    const fragments = tsBlocks().filter(isFragment);
    console.log(`ts blocks: ${tsBlocks().length} (${tsBlocks().length - fragments.length} compiled, ${fragments.length} fragments)`);
    expect(fragments.length).toBeLessThanOrEqual(MAX_TS_FRAGMENTS);
    for (const block of fragments) {
      expect(block.info.includes('reason='), `${block.page}:${block.line}: a ts fragment says why (reason="...")`).toBe(true);
    }
  });
});

describe('TypeScript samples', () => {
  const files = virtualFiles();
  const diagnostics = typeCheck(files);

  it('compile against the real entry points', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]);
  });
});

/** Values of every exported constant object a sample could have used instead of a literal. */
function constantValues(): Set<string> {
  // `ProductKind.Subscription` is also the entity name inside a Razorpay payload (`entity: 'subscription'`), which a sample may spell out.
  const skip = new Set(['HttpMethod', 'HeaderName', 'ContentType', 'HashAlgorithm', 'DigestEncoding', 'RazorpayEvent', 'ProductKind']);
  const values = new Set<string>();
  const checkout = { CheckoutStatus: CheckoutConstants.CheckoutStatus };
  for (const module of [Constants, SchedulerConstants, checkout] as Record<string, unknown>[]) {
    for (const [name, value] of Object.entries(module)) {
      if (skip.has(name) || value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const item of Object.values(value)) {
        if (typeof item === 'string' && item.length > 1) values.add(item);
      }
    }
  }
  return values;
}

describe('no magic strings in TypeScript samples', () => {
  const forbidden = constantValues();
  it('uses constants, not their values', () => {
    const problems: string[] = [];
    for (const block of tsBlocks()) {
      const source = ts.createSourceFile('sample.ts', block.code, ts.ScriptTarget.ES2022, true);
      const visit = (node: ts.Node): void => {
        const textual = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
        const parent = node.parent;
        const isModuleSpecifier =
          parent !== undefined && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isImportTypeNode(parent));
        const isPropertyName = parent !== undefined && ts.isPropertyAssignment(parent) && parent.name === node;
        const isElementKey = parent !== undefined && ts.isElementAccessExpression(parent) && parent.argumentExpression === node;
        const isLiteralType = parent !== undefined && ts.isLiteralTypeNode(parent);
        if (textual && !isModuleSpecifier && !isPropertyName && !isElementKey && !isLiteralType && forbidden.has(node.text)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          problems.push(`${block.page}:${block.line + line}: use the exported constant for "${node.text}"`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(problems).toEqual([]);
  });
});

describe('shell samples', () => {
  const bash = blocks.filter((block) => block.lang === 'bash');
  it('hold one command, without a prompt', () => {
    expect(bash.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const block of bash) {
      const logical = block.code.replace(/\\\n\s*/g, ' ').split('\n').map((line) => line.trim()).filter((line) => line !== '');
      if (logical.length !== 1) problems.push(`${block.page}:${block.line}: ${logical.length} commands in one block`);
      for (const line of logical) {
        if (/^\$\s/.test(line)) problems.push(`${block.page}:${block.line}: remove the "$" prompt`);
        if (/&&|;\s*\S/.test(line.replace(/'[^']*'|"[^"]*"/g, ''))) problems.push(`${block.page}:${block.line}: chained commands`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('JSON samples', () => {
  it('parse', () => {
    for (const block of blocks.filter((candidate) => candidate.lang === 'json')) {
      expect(() => JSON.parse(block.code), `${block.page}:${block.line}`).not.toThrow();
    }
  });
});

describe('Mermaid diagrams', () => {
  it('start with a diagram type the renderer knows', () => {
    const known = /^(flowchart|graph|sequenceDiagram|stateDiagram-v2|stateDiagram|classDiagram|erDiagram)\b/;
    const diagrams = blocks.filter((block) => block.lang === 'mermaid');
    expect(diagrams.length).toBeGreaterThan(0);
    for (const block of diagrams) expect(known.test(block.code.trim()), `${block.page}:${block.line}`).toBe(true);
  });
});

function pythonCommand(): { command: string; env: NodeJS.ProcessEnv } | undefined {
  const venv = join(ROOT, 'clients/python/.venv/bin/python');
  const candidates = existsSync(venv) ? [venv, 'python3'] : ['python3'];
  for (const command of candidates) {
    const probe = spawnSync(command, ['-c', 'import pydantic, httpx'], { cwd: ROOT, env: pythonEnv() });
    if (probe.status === 0) return { command, env: pythonEnv() };
  }
  return undefined;
}

function pythonEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONPATH: join(ROOT, 'clients/python/src') };
}

describe('Python samples', () => {
  const python = blocks.filter((block) => block.lang === 'python');
  const runner = pythonCommand();
  const syntaxOnly = spawnSync('python3', ['--version']).status === 0;

  it.skipIf(!syntaxOnly)('compile', () => {
    const directory = mkdtempSync(join(tmpdir(), 'docs-python-'));
    try {
      python.forEach((block, index) => {
        const file = join(directory, `block_${index}.py`);
        writeFileSync(file, block.code);
        const result = spawnSync('python3', ['-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', file], {
          encoding: 'utf8',
        });
        expect(result.status, `${block.page}:${block.line}: ${result.stderr}`).toBe(0);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(runner === undefined)('import only names the client really exports', () => {
    const directory = mkdtempSync(join(tmpdir(), 'docs-python-'));
    try {
      python.forEach((block, index) => {
        const file = join(directory, `block_${index}.py`);
        writeFileSync(file, block.code);
        const result = spawnSync((runner as NonNullable<typeof runner>).command, [join(ROOT, 'test/docs/python_check.py'), file], {
          encoding: 'utf8',
          env: (runner as NonNullable<typeof runner>).env,
        });
        expect(result.status, `${block.page}:${block.line}: ${result.stdout}${result.stderr}`).toBe(0);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
