/**
 * Shared helpers of the documentation tests: finding the Markdown pages, cutting fenced code blocks out of them and
 * reading the attributes on a fence (```ts title="billing.ts").
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DOCS = join(ROOT, 'docs');

/** Pages that are rendered by VitePress or GitHub from docs/, plus the README at the repository root. */
export function markdownFiles(): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'cache' || entry.startsWith('.')) {
        // `.vitepress` holds configuration, not pages.
        continue;
      }
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (entry.endsWith('.md')) found.push(path);
    }
  };
  visit(DOCS);
  found.push(join(ROOT, 'README.md'));
  return found.sort();
}

export function pageName(path: string): string {
  return relative(ROOT, path).split('\\').join('/');
}

export interface Block {
  /** Path of the page, relative to the repository root. */
  page: string;
  /** 1-based line of the first line of code. */
  line: number;
  lang: string;
  /** Everything after the language on the opening fence. */
  info: string;
  attrs: Record<string, string | true>;
  code: string;
  /** Position of the block among the blocks of its page. */
  index: number;
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/;

export function parseAttrs(info: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  const pattern = /([a-zA-Z][\w-]*)(?:=(?:"([^"]*)"|(\S+)))?/g;
  for (const match of info.matchAll(pattern)) {
    attrs[match[1] as string] = match[2] ?? match[3] ?? true;
  }
  return attrs;
}

export function extractBlocks(path: string): Block[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE.exec(lines[i] as string);
    if (!open) continue;
    const marker = open[2] as string;
    const body: string[] = [];
    let close = i + 1;
    while (close < lines.length) {
      const candidate = (lines[close] as string).trim();
      if (candidate.startsWith(marker[0] as string) && /^(`{3,}|~{3,})$/.test(candidate) && candidate.length >= marker.length) break;
      body.push(lines[close] as string);
      close += 1;
    }
    blocks.push({
      page: pageName(path),
      line: i + 2,
      lang: open[3] as string,
      info: open[4] as string,
      attrs: parseAttrs(open[4] as string),
      code: body.join('\n'),
      index: blocks.length,
    });
    i = close;
  }
  return blocks;
}

export function allBlocks(): Block[] {
  return markdownFiles().flatMap((path) => extractBlocks(path));
}

/** The languages a fence may carry. An untagged fence is a mistake: say what the block is. */
export const ALLOWED_LANGUAGES = [
  'ts',
  'bash',
  'python',
  'go',
  'json',
  'mermaid',
  'text',
  'dockerfile',
  'yaml',
  'sql',
  'html',
  'kotlin',
  'swift',
  'xml',
  'dart',
  'tsx',
] as const;

/** How many `ts fragment` opt-outs the documentation may contain. Raise it only with a reason. */
export const MAX_TS_FRAGMENTS = 6;
