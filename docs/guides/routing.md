# Routing

After this page you will be able to ask the library which of your gateways should take a new subscription or one-time payment, read why it chose that one, tune what "best" means for your business, feed it what you observe, and know the things it will never do.

The router is decision logic and a small statistics store. It never calls a gateway, and it never moves an existing mandate. Every `Subscriptions` client has one, `subs.router`, built over the providers you configured; [purchase sessions](./purchases.md) use it for you, and you can call it yourself.

## What "best" means

The router works in two steps.

1. **Hard filters.** Every gateway that cannot do the job is removed, and the decision says why. A gateway is excluded when:

<!-- generated:begin route-exclusions -->

| Constant | Value | Meaning |
|---|---|---|
| `RouteExclusion.WrongProductKind` | `wrong_product_kind` | The request is for a one-time payment and the gateway does not take them (`oneTimePayments` is false). |
| `RouteExclusion.MissingCapability` | `missing_capability` | The request needs a capability (`needs`) the gateway does not have. |
| `RouteExclusion.PaymentMethodUnsupported` | `payment_method_unsupported` | None of the payment methods the customer can use is one the gateway offers for this product kind. |
| `RouteExclusion.ExcludedByMerchant` | `excluded_by_merchant` | The merchant listed the gateway in the request's `exclude`. |
| `RouteExclusion.Unhealthy` | `unhealthy` | The circuit breaker is open: the gateway kept answering `unavailable` and its cooldown has not passed. |
| `RouteExclusion.AboveMaxAmount` | `above_max_amount` | The amount is above the `maxAmount` the strategy sets for the gateway. |
| `RouteExclusion.BelowMinAmount` | `below_min_amount` | The amount is below the `minAmount` the strategy sets for the gateway. |

<!-- generated:end -->

   Only providers of kind `gateway` are ever candidates. The app stores are not.

2. **Score.** Every gateway that is left gets a score, and the highest wins:

   ```text
   score = weights.successRate * successRate
         + weights.cost        * costFactor
         + weights.priority    * priorityFactor
         + (provider is the one you prefer ? weights.prefer : 0)
   ```

   - **Success rate.** Successes over all observations of the last 24 hours. Subscriptions count the `authorization` and `charge` outcomes, one-time payments the `payment` outcome. With fewer than 20 observations the missing ones are filled in with a prior of 0.9, so a gateway nothing is known about scores the prior, an untried gateway still gets traffic, and confidence builds gradually instead of jumping at a threshold. When the request names payment methods, the rate is the one observed for those methods. A recorded failure can only lower a gateway's score.
   - **Cost.** `1 - fee / amount`, where the fee is `ceil(amount * percentBps / 10000) + fixedPaise` from your cost table. A fee for a payment method replaces the gateway's own; with several possible methods the fees are averaged. A gateway without an entry costs the `defaultCost`, which is zero, so list every gateway once you list any.
   - **Priority.** 1 for the first gateway in your priority list, falling in equal steps to the last, 0 for gateways you did not list. It carries a small weight (0.02), so it settles close calls.
   - **Prefer.** A bonus for the gateway named in the request, for example the one the customer already has a mandate with. It cannot revive a gateway that a hard filter removed.

   The first two factors are on the same scale (a fraction of the amount that arrives), so with equal weights a point of success rate is worth a point of fee. Equal scores are ordered by your priority list and then by provider name, so the same inputs always give the same decision.

## The defaults

Every setting of the strategy is optional. The defaults, read from the schema:

<!-- generated:begin routing-defaults -->

| Setting | Default | Meaning |
|---|---|---|
| `weights.successRate` | `1` | Weight of the success rate (0 to 1). |
| `weights.cost` | `1` | Weight of the share of the amount kept after the gateway's fee (0 to 1). |
| `weights.priority` | `0.02` | Weight of the priority factor (0 to 1). |
| `weights.prefer` | `0.05` | Bonus added to the gateway named in the request's `prefer`. |
| `successRate.windowHours` | `24` | How many hours of statistics to look at. Statistics are kept in whole UTC hours, so the window is rounded out to the hour. |
| `successRate.minSamples` | `20` | Observations needed before the observed rate counts fully. Below it, the missing observations are filled in with `priorRate`. |
| `successRate.priorRate` | `0.9` | The success rate assumed when nothing is known (0 to 1). |
| `successRate.kinds.subscription` | `["authorization","charge"]` | Outcome kinds that count for a subscription. Default: `authorization` and `charge`. |
| `successRate.kinds.one_time` | `["payment"]` | Outcome kinds that count for a one-time payment. Default: `payment`. |
| `costs` | `{}` | What each gateway charges the merchant. Absent for a gateway means `defaultCost` applies. |
| `defaultCost` | `{"percentBps":0,"fixedPaise":0}` | The fee assumed for a gateway that has no entry in `costs`. Default: free, so list every gateway once you list any. |
| `priority` | `[]` | Merchant preference order, most preferred first. Also breaks ties between equal scores. |
| `limits` | `{}` | Per-gateway bounds on the amount the merchant routes there. |
| `circuitBreaker.failureThreshold` | `5` | Consecutive `unavailable` results that open the circuit. |
| `circuitBreaker.cooldownMs` | `60000` | Milliseconds an open circuit waits before it half-opens. |

<!-- generated:end -->

The strategy options are [`RoutingStrategy`](../reference/generated/models.md#routingstrategy); the same tables are in the generated [Routing reference](../reference/generated/routing.md).

## Set it up

Pass the strategy when you create the client. Nothing is required: without one the router uses the defaults.

```ts title="routing-setup.ts"
import { Environment, Provider, cashfree, createSubscriptions, razorpay } from 'india-subscriptions';

export const subs = createSubscriptions({
  providers: [
    razorpay({ keyId: process.env.RAZORPAY_KEY_ID!, keySecret: process.env.RAZORPAY_KEY_SECRET! }),
    cashfree({
      clientId: process.env.CASHFREE_CLIENT_ID!,
      clientSecret: process.env.CASHFREE_CLIENT_SECRET!,
      environment: Environment.Test,
    }),
  ],
  routing: {
    strategy: {
      // What each gateway charges you: 2% for Razorpay, 1.8% plus 3 rupees for Cashfree.
      costs: {
        [Provider.Razorpay]: { percentBps: 200, fixedPaise: 0 },
        [Provider.Cashfree]: { percentBps: 180, fixedPaise: 300 },
      },
      // Most preferred first. Also breaks ties.
      priority: [Provider.Razorpay, Provider.Cashfree],
      // The biggest amount you want a gateway to take, in paise.
      limits: { [Provider.Cashfree]: { maxAmount: 1_500_000 } },
      weights: { successRate: 2 }, // success rate counts double
    },
    onStatsError: (error) => console.warn('routing statistics unavailable', error),
  },
});
```

The router knows no regulatory limit on its own. If a gateway's mandates allow a debit only up to a ceiling without extra authentication, say so in `limits`, and amounts above it go elsewhere.

## Ask for a decision

```ts title="routing-decide.ts"
import { PaymentMethod, ProductKind, Provider, RouteNeed } from 'india-subscriptions';
import { subs } from './routing-setup';

export async function chooseForSubscription(amountInPaise: number) {
  const decision = await subs.router.route({
    kind: ProductKind.Subscription,
    amount: amountInPaise,
    paymentMethods: [PaymentMethod.Upi, PaymentMethod.Card], // the customer can use one of these
    needs: { [RouteNeed.Trial]: true }, // the plan has a free trial
    prefer: Provider.Razorpay, // for example: the gateway the customer already has a mandate with
  });
  return decision.provider; // the best gateway
}
```

A `RouteRequest` (see [Models](../reference/generated/models.md#routerequest)) says what is being sold:

| Field | Meaning |
|---|---|
| `kind` | `subscription` or `one_time`. |
| `amount` | Paise: the amount of every cycle, or of the payment. Checked against your limits and used to price fees. |
| `paymentMethods` | Methods the customer can use. A gateway is a candidate only if it offers one of them: its mandate methods for a subscription, its one-time methods for a payment. |
| `needs` | Capabilities the purchase depends on: `trial`, `upfrontAmount`, `quantity`, `pause`, `cancelAtPeriodEnd`, `changePlan`, `refunds`. |
| `exclude` | Gateways that must not be chosen, for example one that just failed this customer. |
| `prefer` | A gateway to favour. |

`route` has no side effects: the same request against the same capabilities, statistics, strategy and clock gives the same decision.

## Read a decision

The decision explains itself. `provider` is the best gateway, `ranked` lists every eligible gateway best first (the order to try them in), and `candidates` has every gateway that was considered, with its exclusions or its score.

```ts title="routing-explain.ts"
import { ProductKind, type RoutingDecision } from 'india-subscriptions';
import { subs } from './routing-setup';

export async function explain(amountInPaise: number): Promise<string[]> {
  const decision: RoutingDecision = await subs.router.route({ kind: ProductKind.OneTime, amount: amountInPaise });
  return decision.candidates.map((candidate) =>
    candidate.eligible
      ? `${candidate.provider}: score ${candidate.score} (success rate ${candidate.factors?.successRate}, ${candidate.factors?.samples} samples, fee ${candidate.factors?.cost} paise)`
      : `${candidate.provider}: excluded, ${(candidate.details ?? candidate.exclusions).join('; ')}`,
  );
}
```

| Field of a candidate | Meaning |
|---|---|
| `eligible` | True when no hard filter excluded the gateway. |
| `exclusions`, `details` | Every filter that excluded it, as constants, and one readable sentence for each. |
| `score` | The score of an eligible gateway. |
| `factors.successRate`, `factors.samples` | The success rate used, and how many observations it rests on. |
| `factors.cost` | The estimated fee for this amount, in paise. |
| `factors.priority` | 1 for your first gateway, down to 0 for one you did not list. |
| `factors.healthy` | True when the circuit is closed. False when it is half-open and the gateway is on probation. |

When no gateway is eligible, `route` rejects with `NO_ROUTE`, and the message says why each gateway was excluded. Configure another gateway or relax the request.

```ts title="routing-no-route.ts"
import { ErrorCode, ProductKind, isSubscriptionError } from 'india-subscriptions';
import { subs } from './routing-setup';

export async function canSell(amountInPaise: number): Promise<boolean> {
  try {
    await subs.router.route({ kind: ProductKind.Subscription, amount: amountInPaise });
    return true;
  } catch (error) {
    if (isSubscriptionError(error) && error.code === ErrorCode.NoRoute) return false;
    throw error;
  }
}
```

## Create the purchase, and fall back

The router never retries. `ranked` is the fallback order: create the purchase at the first gateway, and if that gateway is down or refuses the inputs, try the next, telling the router what happened. A refusal is a failure for the router, never an outage.

```ts title="routing-create.ts"
import {
  ErrorCode,
  ProductKind,
  RouteOutcomeKind,
  RouteOutcomeResult,
  isSubscriptionError,
  type Customer,
} from 'india-subscriptions';
import { subs } from './routing-setup';

export async function createPaymentWithFallback(orderNumber: string, amountInPaise: number, customer: Customer) {
  const decision = await subs.router.route({ kind: ProductKind.OneTime, amount: amountInPaise });
  for (const provider of decision.ranked) {
    try {
      const payment = await subs.payments.create(provider, { reference: orderNumber, amount: amountInPaise, customer });
      await subs.router.record({ provider, kind: RouteOutcomeKind.Request, result: RouteOutcomeResult.Success });
      return payment;
    } catch (error) {
      const code = isSubscriptionError(error) ? error.code : undefined;
      const unavailable = code === ErrorCode.ProviderUnavailable || code === ErrorCode.Timeout || code === ErrorCode.Network;
      // A gateway that refuses the inputs (VALIDATION, UNSUPPORTED) created nothing, so the next one may take them.
      const refused = code === ErrorCode.Validation || code === ErrorCode.Unsupported;
      await subs.router.record({
        provider,
        kind: RouteOutcomeKind.Request,
        result: unavailable ? RouteOutcomeResult.Unavailable : RouteOutcomeResult.Failure,
      });
      if (!unavailable && !refused) throw error; // anything else (a CONFLICT, say) stops here
    }
  }
  throw new Error('no gateway could create the payment');
}
```

After an `OUTCOME_UNKNOWN` on a write, read the order before you try another gateway, or the customer may end up with two. [Purchase sessions](./purchases.md#when-a-gateway-fails) implement this loop for you, with the exact codes.

## Record outcomes

Routing learns only from what you tell it. `record` takes a `RouteOutcome`:

| Field | Meaning |
|---|---|
| `provider` | The gateway the attempt went to. |
| `kind` | `authorization` (a customer authorising a mandate), `charge` (a recurring debit), `payment` (a one-time payment) or `request` (any other call to the gateway). |
| `result` | `success`, `failure` (the gateway answered and the attempt did not succeed, such as a declined card) or `unavailable` (the gateway could not be reached or errored out). |
| `paymentMethod` | The method used, when known. Recorded in addition to the gateway-wide figures. |
| `at` | When it ended. Defaults to the router's clock. |

```ts title="routing-record.ts"
import {
  EventType,
  RouteOutcomeKind,
  RouteOutcomeResult,
  type SubscriptionEvent,
} from 'india-subscriptions';
import { subs } from './routing-setup';

/** Feed what webhooks say back into routing. */
export async function learnFromEvent(event: SubscriptionEvent): Promise<void> {
  if (event.type === EventType.PaymentSucceeded) {
    await subs.router.record({
      provider: event.provider,
      kind: RouteOutcomeKind.Payment,
      result: RouteOutcomeResult.Success,
      ...(event.payment?.paymentMethod === undefined ? {} : { paymentMethod: event.payment.paymentMethod }),
    });
  }
  if (event.type === EventType.PaymentFailed) {
    await subs.router.record({ provider: event.provider, kind: RouteOutcomeKind.Payment, result: RouteOutcomeResult.Failure });
  }
}
```

[Purchase sessions](./purchases.md) record their own outcomes (the create calls, the verification, and the charge and payment events they see), so record by hand only for payments you create through the explicit routes. Over HTTP the same two calls are `POST /v1/routing/decide` and `POST /v1/routing/outcomes`.

Record a failure when the gateway answered and the attempt did not succeed. Record `unavailable` only when it could not be reached or answered with an outage-class error: that is what feeds the circuit breaker, and a declined card is not an outage.

### The circuit breaker

`failureThreshold` (default 5) consecutive `unavailable` results open a gateway's circuit, which excludes it for `cooldownMs` (default 60 seconds). After that it is half-open: a candidate again, with `healthy: false` in its factors. The next `unavailable` result reopens it for another cooldown, and the next `success` closes it. A `failure` does not move the breaker. While a circuit is half-open every request may go to the gateway until an outcome is recorded, so a busy deployment can send several probes at once.

The breaker's state lives in the router's memory: each process learns about outages from its own traffic, and a restart starts with every circuit closed. Success rates are different: they are kept in the statistics store, which processes can share.

## Where the statistics live

The statistics store counts outcomes in hourly UTC buckets per `(provider, kind, payment method)`. `MemoryRoutingStatsStore` is the default and loses its counts on restart. For several processes or restarts, use `PostgresRoutingStatsStore` from `india-subscriptions/postgres` and pass it as `routing.stats`:

```ts title="routing-postgres.ts"
import { Pool } from 'pg';
import { Provider, createSubscriptions, razorpay } from 'india-subscriptions';
import { PostgresRoutingStatsStore, migratePostgres } from 'india-subscriptions/postgres';

export async function buildClient() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', (error) => console.error('database connection failed', error.message));
  await migratePostgres(pool);

  const subs = createSubscriptions({
    providers: [razorpay({ keyId: process.env.RAZORPAY_KEY_ID!, keySecret: process.env.RAZORPAY_KEY_SECRET! })],
    routing: {
      stats: new PostgresRoutingStatsStore(pool, { retentionHours: 72 }),
      strategy: { priority: [Provider.Razorpay] },
    },
  });
  return { subs, close: () => pool.end() };
}
```

With `DATABASE_URL` the HTTP service does this for you. [How migrations behave](./scheduler.md#running-it-on-postgresql) is the same for all three PostgreSQL stores.

What `PostgresRoutingStatsStore` guarantees:

- **Atomic increments.** `increment` is one `INSERT ... ON CONFLICT DO UPDATE SET n = n + 1` on the row of the series and the hour. PostgreSQL serialises concurrent updates of one row, so counts from many servers are never lost or counted twice.
- **Buckets are the UTC hour** of the instant, computed with `statsBucketStart`, the function every store uses. `read` sums whole buckets at or after the bucket of `since`, inside the database.
- **Independent series.** The gateway-wide series is stored on its own and is never derived from the per-method series.
- **Retention.** Buckets older than `retentionHours` (default 168, seven days; at least 25) are deleted by `prune()`, which `increment` calls at most once an hour per process, on the database's clock.

The statistics are what servers share. The circuit breaker is not: it stays in each process's memory.

### Writing your own

For another database, implement `RoutingStatsStore`. The contract, in short: increments are atomic and additive, buckets are UTC hours (`statsBucketStart`), reads sum whole buckets at or after the bucket of `since`, a key nobody wrote returns zeros, and the gateway-wide series is never derived from the per-method ones (the router writes both). If the store fails to read, routing carries on as if nothing had been observed and calls `onStatsError`: a statistics outage must not stop payments. The full text is in the doc comment of `RoutingStatsStore` in `src/routing/stats-store.ts`, and `test/routing/stats-store.test.ts` and `test/postgres/stats-store.test.ts` show what a correct store does.

## What it never does

- It does not call gateways, check their status pages or probe them.
- It never moves an existing mandate or subscription to another gateway. A UPI Autopay or eNACH mandate can only be debited through the gateway that created it. To keep a returning customer where their mandate is, pass that gateway as `prefer`.
- It does not know any regulatory limit. Amount bounds come from your strategy.
- It does not retry. `ranked` is the fallback order and the caller tries the next gateway.
- It does not fail a request because the statistics store is down.
