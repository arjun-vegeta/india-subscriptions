// Writes the OpenAPI document and a standalone JSON Schema bundle to ./openapi.
// Run with: npm run openapi
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { exportJsonSchemas } from '../src/schema-registry.js';
import { buildOpenApiDocument } from '../src/server/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

mkdirSync('openapi', { recursive: true });
const document = buildOpenApiDocument({ version: pkg.version });
writeFileSync('openapi/openapi.json', JSON.stringify(document, null, 2) + '\n');

const bundle = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'india-subscriptions unified model',
  $defs: exportJsonSchemas({ refPrefix: '#/$defs/', io: 'output' }).schemas,
};
writeFileSync('openapi/schemas.json', JSON.stringify(bundle, null, 2) + '\n');
console.log(`wrote openapi/openapi.json (${Object.keys(document.paths as object).length} paths) and openapi/schemas.json`);
