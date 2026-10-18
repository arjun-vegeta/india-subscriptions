/**
 * The purchases configuration file of the self-hosted service (`PURCHASES_FILE`): one JSON document,
 * `{ "catalog": [...], "policy": {...}, "routing": {...} }`, validated at start-up with the purchase module's own
 * schemas and catalog validation. Every problem is reported in one pass, by field path; no value is ever printed.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ChannelPolicy, ErrorCode } from './constants.js';
import { SubscriptionError } from './errors.js';
import { PlatformPolicySchema, ProductSchema, type PlatformPolicy, type Product } from './purchase/schemas.js';
import { validateCatalog } from './purchase/policy.js';
import { RoutingStrategySchema, type RoutingStrategyInput } from './routing/schemas.js';
import type { Capabilities } from './schemas.js';
import { EnvVar } from './service-config.js';

/** The keys of the file. Anything else is reported: a misspelt `polcy` must not silently mean "the default policy". */
export const PurchasesFileKey = {
  Catalog: 'catalog',
  Policy: 'policy',
  Routing: 'routing',
} as const;
export type PurchasesFileKey = (typeof PurchasesFileKey)[keyof typeof PurchasesFileKey];

const FileSchema = z.object({
  [PurchasesFileKey.Catalog]: z.array(ProductSchema).min(1, { error: 'must list at least one product' }),
  [PurchasesFileKey.Policy]: PlatformPolicySchema.optional(),
  [PurchasesFileKey.Routing]: RoutingStrategySchema.optional(),
});

/** What the file holds, validated. */
export interface PurchasesFileConfig {
  catalog: Product[];
  policy: PlatformPolicy;
  /** The routing strategy as written (the router applies its own defaults). Absent: the router's defaults. */
  routing?: RoutingStrategyInput;
}

export interface LoadPurchasesFileOptions {
  /** The capabilities of every provider the service configured. */
  capabilities: readonly Capabilities[];
  /** Whether a reporter for Google external transactions exists (the `google_play` provider is configured). */
  hasReporter: boolean;
  /** `PUBLIC_BASE_URL`, when set. */
  publicBaseUrl?: string;
  /** Replaces reading the file (tests). */
  readText?: (path: string) => Promise<string>;
}

const MAX_REPORTED_ISSUES = 20;

function failure(path: string, problems: string[]): SubscriptionError {
  return new SubscriptionError(
    ErrorCode.Config,
    `Invalid purchases file ${path} (${EnvVar.PurchasesFile}):\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
  );
}

/**
 * Reads and validates the purchases file. Throws one `CONFIG` error listing every problem: unreadable or invalid JSON,
 * unknown keys, schema violations (by field path), catalog problems (`validateCatalog`: a store product missing for a
 * configured store, a `user_choice` policy without the Google Play provider, a gateway, or a tax rate, ...), and a
 * `user_choice` policy without `PUBLIC_BASE_URL` (the alternative payment opens the hosted checkout).
 */
export async function loadPurchasesFile(path: string, options: LoadPurchasesFileOptions): Promise<PurchasesFileConfig> {
  let text: string;
  try {
    text = await (options.readText ?? ((file: string) => readFile(file, 'utf8')))(path);
  } catch (cause) {
    const reason = cause instanceof Error && 'code' in cause ? ` (${String(cause.code)})` : '';
    throw new SubscriptionError(ErrorCode.Config, `Cannot read purchases file ${path}${reason} (${EnvVar.PurchasesFile})`, { cause });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new SubscriptionError(ErrorCode.Config, `Purchases file ${path} (${EnvVar.PurchasesFile}) is not valid JSON`, { cause });
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw failure(path, ['the file must hold one JSON object: {"catalog": [...], "policy": {...}, "routing": {...}}']);
  }

  const problems: string[] = [];
  const known: readonly string[] = Object.values(PurchasesFileKey);
  for (const key of Object.keys(json)) {
    if (!known.includes(key)) problems.push(`${JSON.stringify(key)}: is not a key of this file (use ${known.join(', ')})`);
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? issue.path.map(String).join('.') : '(file)';
      problems.push(`${where}: ${issue.message}`);
    }
  }
  if (!parsed.success || problems.length > 0) {
    const shown = problems.slice(0, MAX_REPORTED_ISSUES);
    const more = problems.length - shown.length;
    throw failure(path, more > 0 ? [...shown, `and ${more} more`] : shown);
  }

  const policy = parsed.data.policy ?? PlatformPolicySchema.parse({});
  const catalogProblems = validateCatalog({
    catalog: parsed.data.catalog,
    policy,
    capabilities: options.capabilities,
    hasReporter: options.hasReporter,
  }).map((problem) => problem.message);
  if (policy.android === ChannelPolicy.UserChoice && options.publicBaseUrl === undefined) {
    catalogProblems.push(
      `The android policy is user_choice, so ${EnvVar.PublicBaseUrl} must be set: the alternative payment opens the hosted checkout`,
    );
  }
  if (catalogProblems.length > 0) throw failure(path, catalogProblems);

  return {
    catalog: parsed.data.catalog,
    policy,
    ...(parsed.data.routing !== undefined ? { routing: parsed.data.routing } : {}),
  };
}
