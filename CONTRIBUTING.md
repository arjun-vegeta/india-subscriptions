# Contributing

This library moves money. The rules below exist so that a wrong status, a wrong
unit or a silently changed gateway payload fails loudly in tests instead of in
production.

## Layout

```
src/
  constants.ts        shared typed constants (statuses, events, error codes, ...)
  schemas.ts          the gateway-neutral model as Zod schemas (single source of truth)
  provider.ts         SubscriptionProvider contract + BaseProvider plumbing
  errors.ts           SubscriptionError, parseInput, parseResponse
  http.ts             HttpClient (timeouts, safe retries), status -> error code
  crypto.ts           hmac / hash / constant-time compare / header lookup
  money.ts            paise <-> rupees without float maths
  time.ts             IST calendar maths, ISO helpers
  providers/<gateway>/
    constants.ts      that gateway's endpoints, headers, statuses, event names
    schemas.ts        Zod schemas for that gateway's requests, responses, webhooks
    mapper.ts         pure functions: gateway payload -> unified model
    adapter.ts        the SubscriptionProvider implementation
    index.ts          public exports for the gateway
  scheduler/          billing engine for merchant-scheduled mandates
test/
  helpers/mock-fetch.ts
  <gateway>/*.test.ts
```

## Rules

1. **No magic strings.** Any string that carries meaning — a status, an event
   name, a header, an endpoint path, an enum value sent to or received from a
   gateway, an error code, an environment — is a named constant: shared ones in
   `src/constants.ts`, gateway ones in `src/providers/<gateway>/constants.ts`.
   Use the `as const` object + same-named union type pattern already in
   `constants.ts`. JSON field names appear exactly once, in a Zod schema, and
   are otherwise reached through typed property access. Human-readable error
   messages may be literals.

2. **Everything is a schema.** Caller input is validated with `parseInput`
   against the schemas in `schemas.ts`. Every gateway response and webhook body
   is validated against a gateway schema (via `BaseProvider.send` or
   `parseResponse`) before any field is read. No `any`, no unchecked casts of
   network data.

3. **Zod 4 only** (`zod@^4.6`). `import { z } from 'zod'`. Use `z.enum(ConstObject)`,
   `z.looseObject({...})` for gateway payloads (keeps unknown fields),
   `z.record(z.string(), valueSchema)`, `z.iso.datetime({ offset: true })`,
   `z.email()`, `z.url()`, custom messages as `{ error: '...' }`, and
   `z.infer` / `z.input` / `z.output` for types. Do not use `z.nativeEnum`,
   `.passthrough()`, `.strict()` or the Zod 3 `{ message }` form.

4. **Be strict about what you send, tolerant about what you receive.** In a
   gateway response schema, require only the fields the adapter depends on;
   mark the rest `.nullish()` — gateways omit and null fields freely. Parse
   gateway status and event strings as `z.string()` and translate them through
   a `Record<GatewayStatus, UnifiedStatus>` lookup with a documented fallback,
   so a status the gateway adds tomorrow degrades gracefully and is still
   visible verbatim in `providerStatus` / `providerEventType`.

5. **Money is integer paise** in the unified model. Convert at the adapter edge
   with `money.ts` only; never multiply or divide by 100 with floats.

6. **Time is an ISO-8601 string** in the unified model. Use `time.ts` for
   conversion and all calendar arithmetic (it works in IST).

7. **One error type.** Throw only `SubscriptionError` with a code from
   `ErrorCode`. Operations a gateway cannot do throw `unsupported(...)` and are
   reflected in `capabilities`. Never put secrets (key secret, salt, client
   secret, webhook secret) in an error message, a log line or `raw`.

8. **HTTP only through `BaseProvider.send` / `sendRaw`.** Set `idempotent: true`
   only for reads, or for writes that carry a gateway idempotency key — it
   enables automatic retries. A write that gets no response surfaces as
   `OUTCOME_UNKNOWN`; never retry it without fetching current state first.

9. **Verify signatures on the raw bytes** with `crypto.ts` (`assertSignature`
   uses a constant-time compare). A webhook or checkout result whose signature
   does not verify throws `SIGNATURE_INVALID`; nothing is parsed from it.

10. **Tests cite their source.** Fixtures are the sample payloads from the
    gateway's documentation, copied verbatim, with a comment naming the page.
    Each adapter test asserts the exact outgoing request (method, URL, headers,
    body) and the normalised result. Signature tests compute the expected value
    independently with `node:crypto`. Use `test/helpers/mock-fetch.ts`; no real
    network calls in unit tests.

## Commands

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```
