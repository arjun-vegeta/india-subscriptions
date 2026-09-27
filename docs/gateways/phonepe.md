# PhonePe

::: info In progress
The PhonePe adapter is being written. This page will be filled in when it lands: configuration, capabilities, how trials and upfront amounts work, payment methods and limits, status and webhook mappings, and a verification-status note.
:::

Until then, `Provider.PhonePe` exists as a constant, but there is no adapter behind it: `createSubscriptions` cannot be given a PhonePe provider, and the HTTP service has no PhonePe variables. Do not plan a launch around it.

To follow the work or help, see [Adding a gateway](../contributing/adding-a-gateway.md). For the gateways that work today, see [Razorpay](./razorpay.md), [Cashfree](./cashfree.md) and [PayU](./payu.md).
