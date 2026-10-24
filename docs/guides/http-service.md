# Running the HTTP service

After this page you will be able to run the service in production-like conditions: configured, containerised, exposed only where it must be, and protected by its API key.

The service is the library behind a small HTTP API, for applications that are not written in Node (see [Using it from any language](../getting-started/any-language.md)) or that want gateway credentials kept in one place. Its routes are in the [HTTP API reference](../reference/generated/http-api.md).

## Configuration

Everything is an environment variable; the complete list, with which are required and their defaults, is generated in [Environment variables](../reference/generated/environment.md). The short version:

- `INDIA_SUBSCRIPTIONS_API_KEY` is **required**. Clients send it as `Authorization: Bearer <key>`. Use a long random value (the service warns below 16 characters). `--allow-unauthenticated` exists for setups where something in front authenticates for you, and the service says so loudly at startup.
- Each gateway and each app store is switched on by its own variables (`RAZORPAY_*`, `CASHFREE_*`, `PAYU_*`, `PHONEPE_*`, `PAYTM_*`, `APP_STORE_*`, `GOOGLE_PLAY_*`). A half-configured provider is an error, never a silently disabled one.
- `PURCHASES_FILE` and `PURCHASE_STORE_FILE`, both or neither, turn on [purchase sessions](./purchases.md). The file is one JSON document with `catalog`, `policy` and `routing`; the store file holds sessions, entitlements and the queue of reports owed to Google, so it must survive restarts. Run exactly **one** instance. Without them the purchase and entitlement routes answer with a configuration error. The routing strategy is optional; the router always exists.
- `PUBLIC_BASE_URL` is the address customers' browsers reach the service on, such as `https://billing.example.com`. With purchases on, it builds the hosted checkout address of each gateway option and the address gateways return customers to. Use `https`. Without it, options carry no `hostedUrl`, and the policy `user_choice` is refused at start-up, because the alternative payment opens the hosted checkout.
- `SCHEDULER_STORE_FILE` turns the billing scheduler on (it needs a durable file, and exactly **one** service instance). Without it, a merchant-scheduled gateway refuses to create subscriptions.
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

## An example Dockerfile and compose file

These are documentation, not published images. They are not run by this repository's tests. Adapt them.

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

Inside a container the service must listen on `0.0.0.0`, so the **published port** is what you restrict:

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
      EVENTS_WEBHOOK_URL: http://app:3000/billing-events
      EVENTS_WEBHOOK_SECRET: ${EVENTS_WEBHOOK_SECRET}
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
- **Shutdown.** On SIGINT and SIGTERM the service stops its tick loop, waits for a tick in flight, closes the server and releases the store.
- **Health.** `GET /v1/health` returns `ok` and the gateways enabled.
- **State.** With the scheduler on, `SCHEDULER_STORE_FILE` is the source of truth for billing, and with purchases on, `PURCHASE_STORE_FILE` holds sessions, entitlements and the reports owed to Google. Put both on a persistent volume and back them up. Run one instance.
- **Reports to Google.** When the Google Play provider is configured, the service sends the queued reports on every tick, and logs the ones Google refused and the ones past their 24 hour deadline. Alert on that log line: an overdue report breaks Google's reporting rule.
- **Start-up warnings.** The report says when `PUBLIC_BASE_URL` is plain `http`, when it is missing, and when its length means PayU cannot be used for hosted purchases (PayU limits its return address to 50 characters, so PayU is then skipped and the purchase goes to the next gateway).
