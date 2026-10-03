# Running the HTTP service

After this page you will be able to run the service in production-like conditions: configured, containerised, exposed only where it must be, and protected by its API key.

The service is the library behind a small HTTP API, for applications that are not written in Node (see [Using it from any language](../getting-started/any-language.md)) or that want gateway credentials kept in one place. Its routes are in the [HTTP API reference](../reference/generated/http-api.md).

## Configuration

Everything is an environment variable; the complete list, with which are required and their defaults, is generated in [Environment variables](../reference/generated/environment.md). The short version:

- `INDIA_SUBSCRIPTIONS_API_KEY` is **required**. Clients send it as `Authorization: Bearer <key>`. Use a long random value (the service warns below 16 characters). `--allow-unauthenticated` exists for setups where something in front authenticates for you, and the service says so loudly at startup.
- Each gateway is switched on by its own variables. A half-configured gateway is an error, never a silently disabled one.
- `SCHEDULER_STORE_FILE` turns the billing scheduler on (it needs a durable file, and exactly **one** service instance). Without it, a merchant-scheduled gateway refuses to create subscriptions.
- `EVENTS_WEBHOOK_URL` and `EVENTS_WEBHOOK_SECRET`, both or neither, make the service post normalised events to your application. See [Events](../concepts/events.md).

The configuration is validated in one pass: a misconfigured deployment lists every problem at once, naming variables and never values.

## An example Dockerfile and compose file

These are documentation, not published images. They are not run by this repository's tests. Adapt them.

```dockerfile
FROM node:22-alpine
WORKDIR /app
RUN npm install --omit=dev india-subscriptions
# The service writes its scheduler state here.
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
2. **The one exception is the gateway webhook routes**, `POST /v1/{provider}/webhooks`. Gateways cannot send an API key, so these routes need none: each request is authenticated by the gateway's signature over the exact raw body, and a bad signature answers 401. Expose **only** those paths, for example through your reverse proxy, and nothing else.
3. Terminate TLS in front of the service. Plain HTTP between your application and the service is acceptable only on a private network.
4. `GET /v1/health` and `GET /v1/openapi.json` need no key. They reveal which gateways are configured; do not expose them publicly either.
5. The request body limit is 1 MiB. Webhooks are read as raw text, exactly as received.

An nginx location that exposes only the webhook routes looks like this:

```text
location ~ ^/v1/(razorpay|cashfree|payu)/webhooks$ {
    proxy_pass http://127.0.0.1:8787;
    proxy_request_buffering off;
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
- **State.** With the scheduler on, `SCHEDULER_STORE_FILE` is the source of truth for billing. Put it on a persistent volume and back it up. Run one instance.
