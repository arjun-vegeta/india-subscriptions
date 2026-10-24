# The HTTP service functions

Exported from `india-subscriptions/server` (Node only). The routes themselves are in the generated [HTTP API reference](./generated/http-api.md); running it is in [Running the HTTP service](../guides/http-service.md).

## `createHandler(options)` : `(Request) => Promise<Response>`

The service as a Fetch API handler. It runs on Node, Bun, Deno, Cloudflare Workers and inside framework route handlers.

| Option | Meaning |
|---|---|
| `client` | The `Subscriptions` the routes call. Configure the providers, the scheduler, the router and (for the purchase and entitlement routes) `purchases` on it. |
| `apiKey` | Clients must send `Authorization: Bearer <apiKey>` on every route except health, the OpenAPI document, the provider webhook routes and the hosted checkout routes (`/checkout/...`, whose credential is the session id in the path). Compared through digests, so neither the value nor its length is observable through timing. |
| `allowUnauthenticated` | Serve the protected routes without a key. Must be asked for explicitly: without it, a missing `apiKey` throws `CONFIG`. |
| `onEvents(provider, events)` | Called with the verified, normalised events of every webhook received at `POST /v1/{provider}/webhooks`. If it throws, the gateway gets a 500 and retries. |
| `basePath` | A mount prefix such as `/billing`. |
| `maxBodyBytes` | Largest request body. Default 1 MiB (413 above it). |

## `createNodeServer(options)`, `listen(server, { host?, port? })`

`createNodeServer` adapts the handler to `node:http`, streaming the request body through untouched so signatures verify over the exact bytes. `listen` resolves once the socket is bound with `{ server, host, port, url, close }`. The default host is `127.0.0.1`; pass `0.0.0.0` deliberately. Port 0 picks a free port.

## Building blocks of `serve`

| Export | Meaning |
|---|---|
| `runServe({ env?, allowUnauthenticated?, handleSignals?, logger?, fetch? })` | Builds the service from environment variables, starts listening and the tick loop, prints the startup report. Returns `{ service, server, url, port, stop(), stopped }`. |
| `buildService(env, options)` | Everything `serve` needs, built but not listening. |
| `parseServiceEnv(env, { allowUnauthenticated? })` | Validates an environment into a `ServiceConfig`. Throws one `CONFIG` error listing every problem. |
| `createTickLoop({ scheduler, purchases, intervalMs, logger })` | Ticks the scheduler and flushes the Google reports on an interval, never overlapping itself. A failing tick or flush is logged, not thrown. |
| `FileSchedulerStore` | The durable one-file scheduler store. `FileSchedulerStore.open(path)`. Single instance only. |
| `FilePurchaseStore` | The durable one-file store of purchase sessions, entitlements and the Google report queue. `FilePurchaseStore.open(path)`. Single instance only. |
| `loadPurchasesFile(path, options)` | Reads and validates the purchases file: one `CONFIG` error lists every problem. |
| `PurchasesFileKey` | The three keys of the file: `catalog`, `policy`, `routing`. |
| `buildOpenApiDocument({ title?, version?, serverUrl? })` | The OpenAPI 3.1 document. |
| `routes` | The route table the dispatcher and the OpenAPI document are both built from. |
| `ReturnParam`, `returnLocation`, `gatherReturnFields`, `escapeHtml`, `jsonForScript` | The pieces of the hosted checkout: the `session` and `status` parameters added to the return URL, and the helpers that read a return and escape page data. |
| `EnvVar`, `DEFAULT_HOST`, `DEFAULT_PORT`, `DEFAULT_TICK_SECONDS` | The variable names and defaults. |

## The command line

`npx india-subscriptions serve [--allow-unauthenticated]`, `openapi [--server-url <url>]`, `--help`, `--version`. Exit codes: 0 ok, 1 the command ran and failed, 2 bad usage or configuration. The full usage text is in [Environment variables and command line](./generated/environment.md#command-line).

## The events webhook (from the main entry)

`signEventsBody(secret, timestamp, rawBody)`, `verifyEventsSignature(secret, rawBody, headers, { toleranceSeconds?, now? })` (throws `SIGNATURE_INVALID`), `EventsDeliverySchema`, `createEventsSender`, `createEventsForwarder`, `createSchedulerEventsRelay`. The wire format is in [Using it from any language](../getting-started/any-language.md#verifying-the-signature).
