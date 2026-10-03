/**
 * Every relative link of the documentation points at a file that exists and, when it names an anchor, at a heading that exists.
 * An anchor must also be the same on GitHub and on the VitePress site: the two slug a heading differently when punctuation sits
 * between letters (`subs.capabilities()`, `OUTCOME_UNKNOWN`), so such headings cannot be linked to.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markdownFiles, pageName } from './lib.js';

function stripCode(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === undefined && open) fence = open[1];
    else if (fence !== undefined && open && (open[1] as string).startsWith(fence[0] as string) && line.trim().length <= fence.length + 1 && line.trim().startsWith(fence)) fence = undefined;
    else if (fence === undefined) kept.push(line.replace(/`[^`]*`/g, ''));
  }
  return kept.join('\n');
}

function headings(path: string): string[] {
  const result: string[] = [];
  for (const line of stripHeadingFences(readFileSync(path, 'utf8'))) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) result.push((heading[1] as string).replace(/`/g, ''));
  }
  return result;
}

function stripHeadingFences(text: string): string[] {
  const kept: string[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) fence = !fence;
    else if (!fence) kept.push(line);
  }
  return kept;
}

function githubSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

function vitepressSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

describe('links', () => {
  it('resolve to files and headings', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of markdownFiles()) {
      const text = stripCode(readFileSync(file, 'utf8'));
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = match[1] as string;
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [pathPart, anchor] = target.split('#') as [string, string | undefined];
        const destination = pathPart === '' ? file : resolve(dirname(file), pathPart);
        checked += 1;
        if (!existsSync(destination)) {
          problems.push(`${pageName(file)}: ${target} does not exist`);
          continue;
        }
        if (anchor === undefined || !destination.endsWith('.md') || statSync(destination).isDirectory()) continue;
        const wanted = headings(destination).filter((heading) => githubSlug(heading) === anchor || vitepressSlug(heading) === anchor);
        if (wanted.length === 0) problems.push(`${pageName(file)}: ${target}: no heading with that anchor`);
        else if (!wanted.some((heading) => githubSlug(heading) === vitepressSlug(heading))) {
          problems.push(`${pageName(file)}: ${target}: the heading "${wanted[0]}" slugs differently on GitHub and VitePress`);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });
});
