# Reference

Reference pages come in two kinds.

**Generated from the code**, so they cannot drift (a test fails if they differ from what the generator produces):

- [Models](./generated/models.md): every model that crosses the API, with field tables.
- [Enumerations](./generated/enums.md): every constant and its value.
- [Scheduler records and options](./generated/scheduler-records.md): what the billing scheduler stores and accepts.
- [HTTP API](./generated/http-api.md): every route of the service.
- [Environment variables and command line](./generated/environment.md): everything `serve` reads.
- [Errors](./generated/errors.md): every error code.
- [Capability matrix](./generated/capabilities.md): what each provider can do.
- [Routing](./generated/routing.md): the router's defaults, exclusions, outcomes and circuit breaker.
- [Purchases](./generated/purchases.md): where each platform's purchases may go, statuses, defaults, and what the purchases file holds.

**Hand-written**, describing behaviour the code does not carry as data:

- [The client](./client.md): `createSubscriptions` and every method, including payments, the router and purchase sessions.
- [The billing scheduler](./scheduler.md): `BillingScheduler` and the `SchedulerStore` contract.
- [The checkout helper](./checkout.md): `openCheckout`.
- [The HTTP service functions](./http-service.md): `createHandler`, `createNodeServer`, `listen`, `runServe`.
- [PostgreSQL stores](./postgres.md): `india-subscriptions/postgres`, the stores for several servers and the migration.
- [The Python client](./python-client.md).

To regenerate the generated pages after changing the code: `npm run docs:reference`.
