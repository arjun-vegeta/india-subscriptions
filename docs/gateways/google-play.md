# Google Play

::: info In progress
The Google Play adapter is being written. This page will be filled in when it lands: configuration, capabilities, how purchases and renewals map to the unified model, and status and notification mappings.
:::

Until then, `Provider.GooglePlay` exists as a constant, but there is no adapter behind it: `createSubscriptions` cannot be given a Google Play provider, and the HTTP service has no Google Play variables.

To follow the work or help, see [Adding a gateway](../contributing/adding-a-gateway.md). For the gateways that work today, see [Razorpay](./razorpay.md), [Cashfree](./cashfree.md), [PayU](./payu.md), [PhonePe](./phonepe.md) and [Paytm](./paytm.md).
