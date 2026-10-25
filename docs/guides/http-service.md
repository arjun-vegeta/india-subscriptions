# Running the HTTP service

After this page you will be able to run the service in production-like conditions: configured, containerised, exposed only where it must be, and protected by its API key.

The service is the library behind a small HTTP API, for applications that are not written in Node (see [Using it from any language](../getting-started/any-language.md)) or that want gateway credentials kept in one place. Its routes are in the [HTTP API reference](../reference/generated/http-api.md).

## Configuration

Everything is an environment variable; the complete list, with which are required and their defaults, is generated in [Environment variables](../reference/generated/environment.md). The short version:

- `INDIA_SUBSCRIPTIONS_API_KEY` is **required**. Clients send it as `Authorization: Bearer <key>`. Use a long random value (the service warns below 16 characters). `--allow-unauthenticated` exists for setups where something in front authenticates for you, and the service says so loudly at startup.
- Each gateway and each app store is switched on by its own variables (`RAZORPAY_*`, `CASHFREE_*`, `PAYU_*`, `PHONEPE_*`, `PAYTM_*`, `APP_STORE_*`, `GOOGLE_PLAY_*`). A half-configured provider is an error, never a silently disabled one.
- `PURCHASES_FILE` turns on [purchase sessions](./purchases.md), together with a place to keep their state: `PURCHASE_STORE_FILE` (one instance) or `DATABASE_URL` (PostgreSQL). The file is one JSON document with `catalog`, `policy` and `routing`; the state is sessions, entitlements and the queue of reports owed to Google, so it must survive restarts. Without the file the purchase and entitlement routes answer with a configuration error. The routing strategy is optional; the router always exists.
- `PUBLIC_BASE_URL` is the address customers' browsers reach the service on, such as `https://billing.example.com`. With purchases on, it builds the hosted checkout address of each gateway option and the address gateways return customers to. Use `https`. Without it, options carry no `hostedUrl`, and the policy `user_choice` is refused at start-up, because the alternative payment opens the hosted checkout.
- `SCHEDULER_STORE_FILE` turns the billing scheduler on with a durable file, for exactly **one** service instance. `DATABASE_URL` turns it on with PostgreSQL, for any number of instances. Without either, a merchant-scheduled gateway refuses to create subscriptions.
- `DATABASE_URL` keeps all the service's state in PostgreSQL: billing schedules, purchase sessions with entitlements and the report queue, and routing statistics. It replaces `SCHEDULER_STORE_FILE` and `PURCHASE_STORE_FILE`, and setting either of them together with it is an error. `DATABASE_SCHEMA`, `DATABASE_TABLE_PREFIX` and `DATABASE_POOL_SIZE` are optional. See [Using PostgreSQL](#using-postgresql).
- `EVENTS_WEBHOOK_URL` and `EVENTS_WEBHOOK_SECRET`, both or neither, make the service post normalised events to your application. See [Events](../concepts/events.md).

The configuration is validated in one pass: a misconfigured deployment lists every problem at once, naming variables and never values. The purchases file is validated the same way, with the purchase module's own schemas and catalog checks, and a misspelt key is an error rather than a silent default.

A purchases file with one subscription, sold on every platform, and Android customers offered Google's choice screen:

```json
{
  "catalog": [
    {
      "key": "pro-monthly",
      "kind": "subscription",
      "name": "Pro monthly",
      "amount": 49900,
      "interval": { "unit": "month", "count": 1 },
      "taxRateBps": 1800,
      "appStore": { "productId": "com.example.app.pro.monthly" },
      "googlePlay": { "productId": "pro", "basePlanId": "monthly" }
    }
  ],
  "policy": { "android": "user_choice" },
  "routing": {
    "priority": ["razorpay", "cashfree"],
    "limits": { "cashfree": { "maxAmount": 1500000 } }
  }
}
```

The shapes are [`Product`](../reference/generated/models.md#product), [`PlatformPolicy`](../reference/generated/models.md#platformpolicy) and [`RoutingStrategy`](../reference/generated/models.md#routingstrategy).

## Using PostgreSQL

With `DATABASE_URL` the service keeps its state in PostgreSQL instead of files, so several instances can share one database and a restart, or a replaced container, loses nothing.

```bash
npm install pg
```

The service loads the driver, [`pg`](https://node-postgres.com), only when `DATABASE_URL` is set. It is an optional peer dependency of `india-subscriptions`, so a service on files never needs it, and `zod` stays the library's only dependency. Without it installed, the service stops at start-up with one configuration error that names the package.

```text
DATABASE_URL=postgres://billing:s3cret@db.example.com:5432/billing
```

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | A `postgres://` or `postgresql://` connection string. It holds a password: it never appears in a log line or an error message, and the start-up report says "PostgreSQL" and nothing about where. For TLS, add `sslmode=require` to the string. Percent-encode special characters in the password. |
| `DATABASE_SCHEMA` | The schema that holds the tables. Default `public`. Created when it does not exist and the role may create it. |
| `DATABASE_TABLE_PREFIX` | Prepended to every table and index name. Default `india_subscriptions_`. |
| `DATABASE_POOL_SIZE` | The most connections one instance holds open. Default 10. |

**Start-up.** The service connects, runs the [migrations](../reference/postgres.md#migratepostgres) and only then starts listening. They are safe when several instances start at the same moment, so there is no separate migration step. A database that cannot be reached, or a role that cannot create the tables, stops the service with a message naming `DATABASE_URL` and the driver's error code, and exit code 1; a missing driver, or a schema written by a newer version of the library, exits with code 2. The service never half-starts.

**Shutdown.** On SIGINT and SIGTERM the service stops its tick loop, waits for a tick in flight, closes the server, and then closes the pool, which waits for connections still in use.

**Backups.** The database is the source of truth for billing: back it up like any database that holds customer details and mandate ids.

### Running several instances

Every instance runs the same image with the same variables: the same `DATABASE_URL`, `DATABASE_SCHEMA` and `DATABASE_TABLE_PREFIX`, the same gateway credentials, and the same purchases file (the file is configuration, so give each instance its own copy of it; the state is in the database). Put them behind your reverse proxy. What that means:

- **Any instance can answer any request.** A purchase started on one instance is completed on another, and a customer's browser returning from a gateway may reach any of them.
- **Every instance ticks.** Each one runs the billing scheduler and sends the queued Google reports on its own interval. That is safe: the scheduler takes a lock per schedule in the database, and a report is claimed by one instance at a time, so a cycle is debited once and a report is sent once, however many instances tick at the same moment. More instances do not bill faster; `SCHEDULER_TICK_SECONDS` still sets how often each one looks.
- **Events reach your application from the instance that saw them.** A gateway's webhook event is forwarded by the instance that received the webhook, and a scheduler event by the instance whose tick produced it. Every event has a stable `id`: de-duplicate on it, as for any delivery that is at least once.
- **The routing statistics are shared, the circuit breaker is not.** Success rates come from the database; each instance opens and closes a gateway's circuit from its own traffic.
- **Connections add up.** Each instance may hold `DATABASE_POOL_SIZE` connections, so instances times that number must stay below the server's `max_connections`.
- **Upgrades.** An instance migrates the schema when it starts. After an upgrade that adds a migration, an instance still on the old version that restarts refuses to start until it is upgraded too.

## An example Dockerfile and compose file

These are documentation, not published images. They are not run by this repository's tests. Adapt them.

For one instance on files:

```dockerfile
FROM node:22-alpine
WORKDIR /app
RUN npm install --omit=dev india-subscriptions
# The service writes its scheduler state here (and its purchase state, when purchases are on).
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8787 SCHEDULER_STORE_FILE=/data/scheduler.json
EXPOSE 8787
CMD ["node_modules/.bin/india-subscriptions", "serve"]
```

For PostgreSQL, install the driver next to the library and drop the file store:

```dockerfile
FROM node:22-alpine
WORKDIR /app
RUN npm install --omit=dev india-subscriptions pg
USER node
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node_modules/.bin/india-subscriptions", "serve"]
```

Inside a container the service must listen on `0.0.0.0`, so the **published port** is what you restrict. This compose file runs the service and a PostgreSQL database. The database has a health check, and the service starts only once it passes:

```yaml
services:
  db:
    image: postgres:18
    restart: unless-stopped
    environment:
      POSTGRES_USER: billing
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: billing
    volumes:
      # From PostgreSQL 18 the image's volume is /var/lib/postgresql; for 17 and earlier it is /var/lib/postgresql/data.
      - billing-db:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U billing -d billing"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 15s
  billing:
    build: .
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      INDIA_SUBSCRIPTIONS_API_KEY: ${INDIA_SUBSCRIPTIONS_API_KEY}
      DATABASE_URL: postgres://billing:${POSTGRES_PASSWORD}@db:5432/billing
      RAZORPAY_KEY_ID: ${RAZORPAY_KEY_ID}
      RAZORPAY_KEY_SECRET: ${RAZORPAY_KEY_SECRET}
      RAZORPAY_WEBHOOK_SECRET: ${RAZORPAY_WEBHOOK_SECRET}
      EVENTS_WEBHOOK_URL: http://app:3000/billing-events
      EVENTS_WEBHOOK_SECRET: ${EVENTS_WEBHOOK_SECRET}
    ports:
      - "127.0.0.1:8787:8787"
volumes:
  billing-db:
```

`depends_on` with `condition: service_healthy` makes Compose wait for the health check; `restart: unless-stopped` brings the service back if the database is still unreachable when it starts, or goes away later. The database port is not published: only the service reaches it, over the compose network. To run more than one instance, run the `billing` service on several hosts, or behind a proxy network without the fixed host port; they all use the same `DATABASE_URL`.

For one instance on a file instead of a database, mount a volume at `/data` and set `SCHEDULER_STORE_FILE`:

```yaml
services:
  billing:
    build: .
    restart: unless-stopped
    environment:
      INDIA_SUBSCRIPTIONS_API_KEY: ${INDIA_SUBSCRIPTIONS_API_KEY}
      RAZORPAY_KEY_ID: ${RAZORPAY_KEY_ID}
      RAZORPAY_KEY_SECRET: ${RAZORPAY_KEY_SECRET}
      RAZORPAY_WEBHOOK_SECRET: ${RAZORPAY_WEBHOOK_SECRET}
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - billing-data:/data
volumes:
  billing-data:
```

Keep secrets in your secret manager or an untracked `.env`, never in the image. `.env.example` in the repository lists every variable.

## Network exposure rules

1. **Never put the service on the public internet.** It holds live gateway credentials and can move money. Listen on loopback or a private network and let only your own application reach it.
2. **The exceptions are the webhook routes and the hosted checkout.** The webhook routes, `POST /v1/{provider}/webhooks`, need no API key because gateways and stores cannot send one: each request is authenticated by the provider's signature over the exact raw body (for Google Play, by the Google-signed token of the Pub/Sub push), and a bad signature answers 401. If you serve purchases, the hosted checkout routes are public too: `GET /checkout/{sessionId}`, `GET` and `POST /checkout/{sessionId}/return`, and `GET` and `POST /checkout/return/{gateway}` (the short return address PayU uses). The unguessable session id is their credential. Expose **only** those paths, for example through your reverse proxy, and nothing else. See [the hosted checkout page](./purchases.md#the-hosted-checkout-page).
3. Terminate TLS in front of the service. Plain HTTP between your application and the service is acceptable only on a private network.
4. `GET /v1/health` and `GET /v1/openapi.json` need no key. They reveal which gateways are configured; do not expose them publicly either.
5. The request body limit is 1 MiB. Webhooks are read as raw text, exactly as received.

An nginx location that exposes only the webhook routes looks like this:

```text
location ~ ^/v1/(razorpay|cashfree|payu|phonepe|paytm|app_store|google_play)/webhooks$ {
    proxy_pass http://127.0.0.1:8787;
    proxy_request_buffering off;
}
```

With purchases on, add the hosted checkout:

```text
location ~ ^/checkout/(return/[a-z]+|[A-Za-z0-9_-]+(/return)?)$ {
    proxy_pass http://127.0.0.1:8787;
}
```

## Using the handler inside your own server

`createHandler` is a `(Request) => Promise<Response>` function, so it runs on Node, Bun, Deno, Cloudflare Workers and inside framework route handlers. `basePath` strips a mount prefix.

```ts
import { createSubscriptions, razorpay } from 'india-subscriptions';
import { createHandler } from 'india-subscriptions/server';

const subs = createSubscriptions({
  providers: [razorpay({ keyId: process.env.RAZORPAY_KEY_ID!, keySecret: process.env.RAZORPAY_KEY_SECRET! })],
});

// For example, in a Next.js catch-all route handler at app/billing/[...path]/route.ts
const handler = createHandler({
  client: subs,
  apiKey: process.env.INDIA_SUBSCRIPTIONS_API_KEY!,
  basePath: '/billing',
});

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
```

`createNodeServer(options)` and `listen(server, { host, port })` start a `node:http` server instead. `createHandler` throws `CONFIG` unless you pass an `apiKey` or `allowUnauthenticated: true` explicitly.

## Operating it

- **Logs** go to stdout and stderr. Messages never contain secrets or customer details.
- **Shutdown.** On SIGINT and SIGTERM the service stops its tick loop, waits for a tick in flight, closes the server and releases the store (the database pool, with PostgreSQL).
- **Health.** `GET /v1/health` returns `ok` and the gateways enabled.
- **State.** With `DATABASE_URL`, the database is the source of truth for billing, purchases and routing statistics: back it up, and run as many instances as you need. With files, `SCHEDULER_STORE_FILE` is the source of truth for billing and `PURCHASE_STORE_FILE` holds sessions, entitlements and the reports owed to Google: put both on a persistent volume, back them up, and run one instance.
- **Reports to Google.** When the Google Play provider is configured, the service sends the queued reports on every tick, and logs the ones Google refused and the ones past their 24 hour deadline. Alert on that log line: an overdue report breaks Google's reporting rule.
- **Start-up warnings.** The report says when `PUBLIC_BASE_URL` is plain `http`, when it is missing, and when its length means PayU cannot be used for hosted purchases (PayU limits its return address to 50 characters, so PayU is then skipped and the purchase goes to the next gateway).
