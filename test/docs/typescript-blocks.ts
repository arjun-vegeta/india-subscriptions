/**
 * Turns the `ts` fences of the documentation into files of a virtual project and type-checks that project against the real
 * entry points of the package. A fence with a `title` becomes the file of that name (other fences can import it, as
 * `./billing` or `@/billing`); a fence without one becomes a file of its own. `ts fragment` fences are the sparing,
 * counted exception: they are not compiled.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import ts from 'typescript';
import { DOCS, ROOT, allBlocks, type Block } from './lib.js';

export const VIRTUAL_DIR = join(ROOT, 'test/docs/__virtual__');
const AMBIENT = join(ROOT, 'test/docs/ambient.d.ts');

export interface VirtualFile {
  path: string;
  /** Path relative to the virtual root, with `/`. */
  name: string;
  source: string;
  block: Block;
}

export function tsBlocks(): Block[] {
  return allBlocks().filter((block) => block.lang === 'ts');
}

export function isFragment(block: Block): boolean {
  return block.attrs.fragment === true;
}

/** The virtual file of every compiled `ts` fence, keyed by its path. */
export function virtualFiles(): VirtualFile[] {
  const files: VirtualFile[] = [];
  const used = new Set<string>();
  for (const block of tsBlocks()) {
    if (isFragment(block)) continue;
    const title = typeof block.attrs.title === 'string' ? block.attrs.title : undefined;
    const slug = block.page.replace(/[^a-zA-Z0-9]+/g, '_');
    const name = title ?? `__${slug}_${block.index}.ts`;
    if (used.has(name)) throw new Error(`${block.page}:${block.line}: two code blocks are titled "${name}"`);
    used.add(name);
    files.push({ path: join(VIRTUAL_DIR, name), name, source: block.code, block });
  }
  return files;
}

function compilerOptions(): ts.CompilerOptions {
  const { options } = ts.convertCompilerOptionsFromJson(
    {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      types: ['node'],
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      noEmit: true,
      isolatedModules: true,
      resolveJsonModule: true,
      baseUrl: ROOT,
      paths: {
        'india-subscriptions': ['src/index.ts'],
        'india-subscriptions/server': ['src/server-entry.ts'],
        'india-subscriptions/checkout': ['src/checkout/index.ts'],
        '@/*': ['test/docs/__virtual__/*'],
      },
    },
    ROOT,
  );
  return options;
}

export interface Diagnostic {
  file: string;
  /** Line in the Markdown page. */
  line: number;
  message: string;
}

/** Type-checks every file and returns the problems, positioned in the Markdown page. */
export function typeCheck(files: VirtualFile[], extraRoots: string[] = []): Diagnostic[] {
  const options = compilerOptions();
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const host = ts.createCompilerHost(options);
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);
  const realGetSourceFile = host.getSourceFile.bind(host);
  const realDirectoryExists = host.directoryExists?.bind(host);
  host.fileExists = (path) => byPath.has(path) || realFileExists(path);
  host.readFile = (path) => byPath.get(path)?.source ?? realReadFile(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreate) => {
    const virtual = byPath.get(path);
    if (virtual) return ts.createSourceFile(path, virtual.source, languageVersion, true);
    return realGetSourceFile(path, languageVersion, onError, shouldCreate);
  };
  host.directoryExists = (path) => path === VIRTUAL_DIR || path.startsWith(`${VIRTUAL_DIR}/`) || (realDirectoryExists?.(path) ?? true);

  const program = ts.createProgram({
    rootNames: [...files.map((file) => file.path), AMBIENT, ...extraRoots],
    options,
    host,
  });
  const found: Diagnostic[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file.path);
    if (!source) {
      found.push({ file: file.block.page, line: file.block.line, message: 'the block was not compiled' });
      continue;
    }
    const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
    for (const diagnostic of diagnostics) {
      const start = diagnostic.start === undefined ? 0 : source.getLineAndCharacterOfPosition(diagnostic.start).line;
      found.push({
        file: file.block.page,
        line: file.block.line + start,
        message: `${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')} (TS${diagnostic.code})`,
      });
    }
  }
  return found;
}

/** Real files outside the Markdown pages that the documentation promises type-check (the worked examples). */
export function exampleFiles(): VirtualFile[] {
  const directory = join(DOCS, 'examples');
  if (!existsSync(directory)) return [];
  const result: VirtualFile[] = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of ts.sys.readDirectory(current, ['.ts'])) {
      const name = posix.join('examples', relative(directory, entry).split('\\').join('/'));
      result.push({
        path: entry,
        name,
        source: readFileSync(entry, 'utf8'),
        block: { page: `docs/${name}`, line: 1, lang: 'ts', info: '', attrs: {}, code: '', index: 0 },
      });
    }
  }
  return result;
}
