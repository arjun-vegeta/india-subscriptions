# Documentation site

This folder is the documentation of `india-subscriptions`. It reads well on GitHub as it is, and it also builds as a searchable site with [VitePress](https://vitepress.dev). The site tooling lives only in this folder: `docs/package.json` holds the site's dependencies, and nothing is added to the library's own `package.json`.

## Preview the site

```bash
npm --prefix docs install
```

```bash
npm --prefix docs run dev
```

`npm --prefix docs run build` writes a static site to `docs/.vitepress/dist`, and `npm --prefix docs run preview` serves it. No deployment workflow is included; publishing the built folder is up to you. Diagrams are Mermaid, rendered in the browser (GitHub renders them natively).

## What is generated

`docs/reference/generated/` and the tables inside the provider pages and some guides (between `<!-- generated:begin ... -->` and `<!-- generated:end -->`) are generated from the code. Do not edit them by hand. The generated pages include the routing defaults and exclusions (`reference/generated/routing.md`) and the platform policy matrix, statuses and defaults of purchase sessions (`reference/generated/purchases.md`); the guides on one-time payments, routing and purchases and the entitlements concept carry generated regions for the per-gateway payment methods, the strategy defaults, the platform policy and the entitlement statuses.

```bash
npm run docs:reference
```

Run it from the repository root after changing a schema, a route, an environment variable, an error code, or an adapter's capabilities or mapping tables. A test fails when the committed files differ from what the generator produces.

## How the samples are tested

```bash
npx vitest run test/docs
```

- Every `ts` code block is type-checked against the real entry points (`india-subscriptions`, `/server`, `/checkout`). A block with `title="name.ts"` is a file other blocks can import. A block marked `ts fragment reason="..."` is exempt, and the number of exemptions is capped.
- TypeScript samples use the exported constants, never their string values.
- The main flows (the first-subscription walkthrough for Express and Next.js, managing subscriptions, one-time payments, routing, a web purchase and an Android user choice purchase through the HTTP service, an iPhone purchase start, the mobile backend that forwards the five calls, the events signature in TypeScript, Python and Go, the curl commands) are executed against scripted provider responses.
- Python samples are compiled and their imports checked against `clients/python`. Kotlin and Swift fences are shown as written and are not compiled. Shell samples are one command each, with no `$` prompt.
- Every relative link and anchor is checked.

## Layout

```text
index.md               overview
getting-started/       installation, first subscription, any language
concepts/              how recurring payments work, lifecycle, trials, scheduling, events, entitlements, money and time, errors
guides/                checkout, one-time payments, routing, purchases, store setup, mobile apps, webhooks, managing, scheduler, HTTP service, security, testing, going live
gateways/              one page per provider: five gateways and the two app stores
reference/             hand-written reference, and generated/ for the generated pages
contributing/          architecture and adding a gateway
examples/              worked examples that are type-checked
```
