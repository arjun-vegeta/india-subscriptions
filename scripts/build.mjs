// Dual ESM + CommonJS build using plain tsc, no bundler.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
for (const project of ['tsconfig.esm.json', 'tsconfig.cjs.json']) {
  execFileSync('npx', ['tsc', '-p', project], { stdio: 'inherit' });
}
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }) + '\n');
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }) + '\n');
console.log('built dist/esm and dist/cjs');
