# Reference

Reference pages come in two kinds.

**Generated from the code**, so they cannot drift (a test fails if they differ from what the generator produces):

- [Models](./generated/models.md): every model that crosses the API, with field tables.
- [Enumerations](./generated/enums.md): every constant and its value.
- [Scheduler records and options](./generated/scheduler-records.md): what the billing scheduler stores and accepts.
- [HTTP API](./generated/http-api.md): every route of the service.
- [Environment variables and command line](./generated/environment.md): everything `serve` reads.
- [Errors](./generated/errors.md): every error code.
- [Capability matrix](./generated/capabilities.md): what each gateway can do.

**Hand-written**, describing behaviour the code does not carry as data:

- [The client](./client.md): `createSubscriptions` and every method.
- [The billing scheduler](./scheduler.md): `BillingScheduler` and the `SchedulerStore` contract.
- [The checkout helper](./checkout.md): `openCheckout`.
- [The HTTP service functions](./http-service.md): `createHandler`, `createNodeServer`, `listen`, `runServe`.
- [The Python client](./python-client.md).

To regenerate the generated pages after changing the code: `npm run docs:reference`.
