# Installation

After this page you will have the package installed and know which of the three entry points you need.

## Requirements

- Node 18.17 or later.
- An account with at least one supported gateway, and its **test-mode** keys. Start in test mode.

The package has one runtime dependency, `zod`.

## Install

```bash
npm install india-subscriptions
```

## The four entry points

| Import from | For | Runs in |
|---|---|---|
| `india-subscriptions` | The client (`createSubscriptions`), the gateway adapters, every schema and constant, the billing scheduler, the in-memory store | Node, and any runtime with `fetch` |
| `india-subscriptions/checkout` | `openCheckout`: runs the customer's authorisation step in the browser | The browser only. It imports no Node module and never sees a secret. |
| `india-subscriptions/server` | The HTTP service (`createHandler`, `createNodeServer`, `listen`), the durable `FileSchedulerStore`, and the pieces `serve` is built from | Node only |
| `india-subscriptions/postgres` | The scheduler, purchase and routing-statistics stores on PostgreSQL, and `migratePostgres`. You bring the driver (`npm install pg`). See [PostgreSQL stores](../reference/postgres.md). | Node only |

The main entry deliberately does not include `node:http` or any browser code, so you can import it anywhere.

## Run the service instead

If your application is not written in Node, you do not install the package into it. You run the service, which needs Node, and call it over HTTP:

```bash
npx india-subscriptions serve
```

See [Using it from any language](./any-language.md).

## Environment

The samples in this documentation read their keys from the environment. For Razorpay:

```text
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

Never commit keys, and never send a secret to the browser. The only value of yours the browser receives is what the checkout instruction contains, and the library builds that to exclude every secret.

## Next

[Your first subscription](./first-subscription.md) builds the full flow, from the server route to the webhook.
