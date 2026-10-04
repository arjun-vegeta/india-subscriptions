# Architecture overview

After this page you will know how the code is organised, where data flows, and which rules every contribution must follow. For the code rules in short form see `CONTRIBUTING.md` at the repository root.

## Modules and data flow

```mermaid
flowchart TB
  subgraph Public["Public surface"]
    Main["india-subscriptions (client.ts, index.ts)"]
    Server["india-subscriptions/server (HTTP service, FileSchedulerStore)"]
    Checkout["india-subscriptions/checkout (browser)"]
  end
  subgraph Core["Core"]
    Schemas["schemas.ts, constants.ts (the unified model, Zod)"]
    Errors["errors.ts (SubscriptionError)"]
    Sched["scheduler/ (BillingScheduler, SchedulerStore)"]
    Provider["provider.ts (SubscriptionProvider, BaseProvider)"]
    Http["http.ts, crypto.ts, money.ts, time.ts"]
  end
  subgraph Adapters["providers/"]
    RZP["razorpay/"]
    CF["cashfree/"]
    PU["payu/"]
    PP["phonepe/"]
    PT["paytm/"]
  end
  Main --> Sched
  Main --> Provider
  Server --> Main
  Checkout --> Schemas
  Sched --> Provider
  Provider --> Schemas
  Provider --> Http
  RZP --> Provider
  CF --> Provider
  PU --> Provider
  PP --> Provider
  PT --> Provider
  Adapters --> Gateways["Gateway HTTP APIs"]
```

A call such as `subs.create(Provider.PayU, input)` flows like this:

1. `client.ts` picks the adapter by name and decides, from its `capabilities`, whether a scheduler is needed.
2. The adapter validates `input` with the shared Zod schema (`parseInput`), translates it to the gateway's request, sends it through `BaseProvider.send` (which validates the gateway's response with the adapter's own schema) and maps the answer to a unified `Subscription` with a pure function in `mapper.ts`.
3. For a merchant-scheduled subscription the client registers a schedule with `BillingScheduler`, which stores it through a `SchedulerStore`.
4. Later, `tick()` asks the store which schedules are due, takes a per-schedule lock and talks to the adapter through the same `SubscriptionProvider` interface: the scheduler knows nothing about any gateway.

The HTTP service is a thin layer over the same client. The route table in `server/routes.ts` is read by both the request dispatcher and the OpenAPI generator, so the documentation of the API cannot disagree with its behaviour. The Python client is generated from that OpenAPI document.

## Layout

| Path | Role |
|---|---|
| `src/constants.ts` | Shared typed constants: statuses, events, error codes |
| `src/schemas.ts` | The gateway-neutral model as Zod schemas: the single source of truth for types, validation and the OpenAPI document |
| `src/schema-registry.ts` | The published names of the model (a rename is a breaking change for generated clients) |
| `src/provider.ts` | The `SubscriptionProvider` contract and `BaseProvider` plumbing |
| `src/errors.ts`, `src/http.ts`, `src/crypto.ts`, `src/money.ts`, `src/time.ts` | Error type, HTTP client with safe retries, signatures, paise and rupees, IST calendar |
| `src/providers/<gateway>/` | `constants.ts`, `schemas.ts`, `mapper.ts`, `adapter.ts`, `index.ts` |
| `src/scheduler/` | The billing engine and the store contract |
| `src/server/`, `src/service.ts`, `src/service-config.ts`, `src/cli.ts` | The HTTP service and `serve` |
| `src/events-webhook.ts`, `src/events-envelope.ts` | The signed events webhook |
| `src/checkout/` | The browser helper |
| `clients/python/` | The generated Python client |
| `test/` | Unit tests per area, `integration/` (real adapters through the real facade), `docs/` (these pages) |
| `scripts/` | Build, OpenAPI export, the documentation generator, the live-check scripts |

## Rules that shape the code

- **No magic strings.** Every string that carries meaning is a named constant, shared in `src/constants.ts` or per gateway in `src/providers/<gateway>/constants.ts`. JSON field names appear once, in a Zod schema.
- **Everything is a schema.** Caller input and every gateway response are validated before any field is read. Gateway response schemas require only what the adapter reads; statuses are plain strings translated through a lookup table with a documented fallback, so a status added tomorrow degrades gracefully.
- **Money is integer paise; time is an ISO-8601 string.** Conversion happens at the adapter edge.
- **One error type.** Only `SubscriptionError` with a code from `ErrorCode`. Never a secret in a message, a log line or `raw`.
- **HTTP only through `BaseProvider.send`.** `idempotent: true` only for reads or writes with a gateway idempotency key. A write that gets no answer is `OUTCOME_UNKNOWN`.
- **Verify signatures on the raw bytes**, in constant time.
- **Tests cite their source.** Fixtures are the gateway documentation's sample payloads, verbatim, with a comment naming the page.

## How the documentation stays true

`scripts/generate-docs-reference.ts` generates the reference pages and the tables inside the gateway pages from the code. `test/docs/` extracts every code sample from the Markdown, type-checks it against the real entry points, runs the main flows against scripted gateway responses, and checks links. Run `npm run docs:reference` after changing a schema, a route, an environment variable, an error code or an adapter's capabilities or mapping tables.
