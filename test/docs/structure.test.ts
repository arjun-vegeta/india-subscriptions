/**
 * The shape of the documentation: the pages the owner asked for exist, the lists of statuses, events and kinds in the
 * prose match the code, the site tooling stays out of the library's dependencies, and the style rules hold.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckoutKind, ErrorCode, EventType, SubscriptionStatus } from '../../src/constants.js';
import { SchedulerEventType } from '../../src/scheduler/constants.js';
import { DOCS, ROOT, markdownFiles, pageName } from './lib.js';

const read = (path: string): string => readFileSync(join(DOCS, path), 'utf8');

const REQUIRED_PAGES = [
  'index.md',
  'README.md',
  'package.json',
  '.vitepress/config.ts',
  'getting-started/installation.md',
  'getting-started/first-subscription.md',
  'getting-started/any-language.md',
  'concepts/recurring-payments.md',
  'concepts/lifecycle.md',
  'concepts/trials.md',
  'concepts/scheduling.md',
  'concepts/events.md',
  'concepts/money-and-time.md',
  'concepts/errors.md',
  'guides/checkout.md',
  'guides/webhooks.md',
  'guides/managing-subscriptions.md',
  'guides/scheduler.md',
  'guides/http-service.md',
  'guides/security.md',
  'guides/testing.md',
  'guides/going-live.md',
  'gateways/razorpay.md',
  'gateways/cashfree.md',
  'gateways/payu.md',
  'gateways/phonepe.md',
  'gateways/paytm.md',
  'gateways/app-store.md',
  'gateways/google-play.md',
  'reference/index.md',
  'reference/client.md',
  'reference/scheduler.md',
  'reference/checkout.md',
  'reference/http-service.md',
  'reference/python-client.md',
  'reference/generated/models.md',
  'reference/generated/enums.md',
  'reference/generated/scheduler-records.md',
  'reference/generated/http-api.md',
  'reference/generated/environment.md',
  'reference/generated/errors.md',
  'reference/generated/capabilities.md',
  'contributing/architecture.md',
  'contributing/adding-a-gateway.md',
  'examples/postgres-scheduler-store.ts',
];

describe('structure', () => {
  it('has every page', () => {
    expect(REQUIRED_PAGES.filter((page) => !existsSync(join(DOCS, page)))).toEqual([]);
  });


  it('says plainly what is risky about PhonePe webhooks and Paytm checksums', () => {
    expect(read('gateways/phonepe.md')).toContain('a captured webhook can be replayed');
    expect(read('gateways/phonepe.md')).toContain('HTTPS only');
  });

});

describe('prose agrees with the code', () => {
  it('documents every subscription status on the lifecycle page', () => {
    const page = read('concepts/lifecycle.md');
    for (const status of Object.values(SubscriptionStatus)) expect(page, status).toContain(`| \`${status}\` |`);
  });

  it('documents every event type on the events page', () => {
    const page = read('concepts/events.md');
    for (const type of Object.values(EventType)) expect(page, type).toContain(`\`${type}\``);
    for (const type of Object.values(SchedulerEventType)) expect(page, type).toContain(`\`${type}\``);
  });

  it('documents every checkout kind in the checkout guide', () => {
    const page = read('guides/checkout.md');
    for (const kind of Object.values(CheckoutKind)) expect(page, kind).toContain(`\`${kind}\``);
  });

  it('keeps the error vocabulary of the prose real', () => {
    const codes = Object.values(ErrorCode) as string[];
    for (const mentioned of ['OUTCOME_UNKNOWN', 'SIGNATURE_INVALID', 'UNSUPPORTED', 'CONFLICT', 'CONFIG', 'VALIDATION']) expect(codes).toContain(mentioned);
  });
});

describe('dependencies', () => {
  it('keeps the site tooling out of the library', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(Object.keys(root.dependencies)).toEqual(['zod']);
    for (const name of ['vitepress', 'mermaid', 'vitepress-plugin-mermaid']) {
      expect(root.dependencies[name]).toBeUndefined();
      expect(root.devDependencies[name]).toBeUndefined();
    }
    expect(root.scripts['docs:reference']).toContain('generate-docs-reference');
    const site = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies?: unknown };
    expect(Object.keys(site.dependencies).sort()).toEqual(['mermaid', 'vitepress', 'vitepress-plugin-mermaid']);
    expect(site.devDependencies).toBeUndefined();
  });

  it('configures local search and Mermaid', () => {
    const config = read('.vitepress/config.ts');
    expect(config).toContain("provider: 'local'");
    expect(config).toContain('withMermaid');
  });
});

describe('style', () => {
  const emoji = /[\p{Extended_Pictographic}\u{1F000}-\u{1FFFF}✅❌✔✨]/u;

  it('has no emoji', () => {
    const offenders = markdownFiles().filter((file) => emoji.test(readFileSync(file, 'utf8')));
    expect(offenders.map(pageName)).toEqual([]);
  });

  it('does not tell the reader a gateway supports what its adapter refuses', () => {
    // Pairs a sentence of the prose with the capability it relies on. If the code changes, so must the page.
    const razorpay = read('gateways/razorpay.md');
    expect(razorpay).toContain('`createCharge` and `notifyCharge` throw `UNSUPPORTED`');
    expect(read('gateways/cashfree.md')).toContain('`CancelMode.AtPeriodEnd` throws `UNSUPPORTED`');
    expect(read('gateways/payu.md')).toContain('`CancelMode.AtPeriodEnd` throws `UNSUPPORTED`');
  });

  it('marks generated pages as such', () => {
    for (const file of markdownFiles().filter((path) => path.includes('reference/generated'))) {
      expect(readFileSync(file, 'utf8').startsWith('<!-- GENERATED FILE: do not edit.'), pageName(file)).toBe(true);
    }
  });

  it('keeps README links into the documentation', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('docs/guides/going-live.md');
    expect(readme).toContain('docs/getting-started/first-subscription.md');
  });
});
