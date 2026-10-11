/*
 * Verbatim sample payloads from the Razorpay documentation, one page each (named above every constant).
 * Placeholders such as "<email>" are the documentation's own.
 */

/** Verbatim sample, razorpay.com/docs/api/orders/create "Success" response. */
export const ORDER_CREATED = String.raw`{
  "amount": 5000,
  "amount_due": 5000,
  "amount_paid": 0,
  "attempts": 0,
  "created_at": 1756455561,
  "currency": "INR",
  "entity": "order",
  "id": "order_RB58MiP5SPFYyM",
  "notes": {
      "key1": "value3",
      "key2": "value2"
  },
  "offer_id": null,
  "receipt": "receipt#1",
  "status": "created"
}`;

/** Verbatim sample, razorpay.com/docs/api/orders/create "Failure" response. */
export const ORDER_CREATE_FAILURE = String.raw`{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "The amount must be at least INR 1.00",
    "source": "business",
    "step": "payment_initiation",
    "reason": "input_validation_failed",
    "metadata": {},
    "field": "amount"
  }
}`;

/** Verbatim sample, razorpay.com/docs/api/orders/fetch-with-id "Success" response. */
export const ORDER_FETCHED = String.raw`{
    "id": "order_DaaS6LOUAASb7Y",
    "entity": "order",
    "amount": 2000,
    "amount_paid": 0,
    "amount_due": 2000,
    "currency": "INR",
    "receipt": null,
    "offer_id": "offer_JGQvQtvJmVDRIA",
    "offers": [
        "offer_JGQvQtvJmVDRIA"
    ],
    "status": "created",
    "attempts": 0,
    "notes": [],
    "created_at": 1654776878
}`;

/** Verbatim sample, razorpay.com/docs/api/orders/fetch-payments "Success" response. */
export const ORDER_PAYMENTS = String.raw`{
  "entity":"collection",
  "count":2,
  "items":[
    {
      "id":"pay_N8FUmetkCE2hZP",
      "entity":"payment",
      "amount":100,
      "currency":"INR",
      "status":"failed",
      "order_id":"order_N8FRN5zTm5S3wx",
      "invoice_id":null,
      "international":false,
      "method":"upi",
      "amount_refunded":0,
      "refund_status":null,
      "captured":false,
      "description":null,
      "card_id":null,
      "bank":null,
      "wallet":null,
      "vpa":"failure@razorpay",
      "email":"void@razorpay.com",
      "contact":"+919999999999",
      "notes":{
        "notes_key_1":"Tea, Earl Grey, Hot",
        "notes_key_2":"Tea, Earl Grey… decaf."
      },
      "fee":null,
      "tax":null,
      "error_code":"BAD_REQUEST_ERROR",
      "error_description":"Payment was unsuccessful due to a temporary issue. If amount got deducted, it will be refunded within 5-7 working days.",
      "error_source":"gateway",
      "error_step":"payment_response",
      "error_reason":"payment_failed",
      "acquirer_data":{
        "rrn":null
      },
      "created_at":1701688684,
      "upi":{
        "vpa":"failure@razorpay"
      }
    },
    {
      "id":"pay_N8FVRD1DzYzBh1",
      "entity":"payment",
      "amount":100,
      "currency":"INR",
      "status":"captured",
      "order_id":"order_N8FRN5zTm5S3wx",
      "invoice_id":null,
      "international":false,
      "method":"upi",
      "amount_refunded":0,
      "refund_status":null,
      "captured":true,
      "description":null,
      "card_id":null,
      "bank":null,
      "wallet":null,
      "vpa":"success@razorpay",
      "email":"void@razorpay.com",
      "contact":"+919999999999",
      "notes":{
        "notes_key_1":"Tea, Earl Grey, Hot",
        "notes_key_2":"Tea, Earl Grey… decaf."
      },
      "fee":2,
      "tax":0,
      "error_code":null,
      "error_description":null,
      "error_source":null,
      "error_step":null,
      "error_reason":null,
      "acquirer_data":{
        "rrn":"267567962619",
        "upi_transaction_id":"F5B66C7C07CA6FEAD77E956DC2FC7ABE"
      },
      "created_at":1701688721,
      "upi":{
        "vpa":"success@razorpay"
      }
    }
  ]
}`;

/** Verbatim sample, razorpay.com/docs/api/refunds/create-normal "Success" response. */
export const REFUND_CREATED = String.raw`{
  "id": "rfnd_FP8QHiV938haTz",
  "entity": "refund",
  "amount": 500100,
  "base_amount": 500100,
  "currency": "INR",
  "payment_id": "pay_29QQoUBi66xm2f",
  "notes": [],
  "receipt": "Receipt No. 31",
  "acquirer_data": {
    "arn": null
  },
  "created_at": 1597078866,
  "batch_id": null,
  "status": "processed",
  "speed_processed": "normal",
  "speed_requested": "normal"
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/payments "Payment Authorised", Netbanking. */
export const WEBHOOK_PAYMENT_AUTHORIZED = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "payment.authorized",
  "contains": [
    "payment"
  ],
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_DESlfW9H8K9uqM",
        "entity": "payment",
        "amount": 100,
        "currency": "INR",
        "status": "authorized",
        "order_id": "order_DESlLckIVRkHWj",
        "invoice_id": null,
        "international": false,
        "method": "netbanking",
        "amount_refunded": 0,
        "refund_status": null,
        "captured": false,
        "description": null,
        "card_id": null,
        "bank": "HDFC",
        "wallet": null,
        "vpa": null,
        "email": "<email>",
        "contact": "<phone>",
        "notes": [],
        "fee": null,
        "tax": null,
        "error_code": null,
        "error_description": null,
        "error_source": null,
        "error_step": null,
        "error_reason": null,
        "acquirer_data": {
          "bank_transaction_id": "0125836177"
        },
        "created_at": 1567674599
      }
    }
  },
  "created_at": 1567674606
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/payments "Payment Captured", Netbanking. */
export const WEBHOOK_PAYMENT_CAPTURED = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "payment.captured",
  "contains": [
    "payment"
  ],
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_DESlfW9H8K9uqM",
        "entity": "payment",
        "amount": 100,
        "currency": "INR",
        "base_amount": 100,
        "status": "captured",
        "order_id": "order_DESlLckIVRkHWj",
        "invoice_id": null,
        "international": false,
        "method": "netbanking",
        "amount_refunded": 0,
        "amount_transferred": 0,
        "refund_status": null,
        "captured": true,
        "description": null,
        "card_id": null,
        "bank": "HDFC",
        "wallet": null,
        "vpa": null,
        "email": "<email>",
        "contact": "<phone>",
        "notes": [],
        "fee": 2,
        "tax": 0,
        "error_code": null,
        "error_description": null,
        "error_source": null,
        "error_step": null,
        "error_reason": null,
        "acquirer_data": {
          "bank_transaction_id": "0125836177"
        },
        "created_at": 1567674599
      }
    }
  },
  "created_at": 1567674606
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/payments "Payment Captured", Card. */
export const WEBHOOK_PAYMENT_CAPTURED_CARD = String.raw`{
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "contains": [
    "payment"
  ],
  "created_at": 1691735748,
  "entity": "event",
  "event": "payment.captured",
  "payload": {
    "payment": {
      "entity": {
        "acquirer_data": {
          "auth_code": "828553",
          "rrn": "322206890934"
        },
        "amount": 100,
        "amount_refunded": 0,
        "amount_transferred": 0,
        "bank": null,
        "captured": true,
        "card": {
          "emi": false,
          "entity": "card",
          "id": "card_DESp9fNnu0RoNc",
          "iin": "999999",
          "international": false,
          "issuer": null,
          "last4": "0153",
          "name": "<name>",
          "network": "Visa",
          "sub_type": "business",
          "type": "debit"
        },
        "card_id": "card_DESp9fNnu0RoNc",
        "contact": "<phone>",
        "created_at": 1567674797,
        "currency": "INR",
        "description": null,
        "email": "<email>",
        "entity": "payment",
        "error_code": "",
        "error_description": "",
        "error_reason": null,
        "error_source": null,
        "error_step": null,
        "fee": null,
        "id": "pay_DESp9bgForNoUd",
        "international": false,
        "invoice_id": null,
        "method": "card",
        "notes": [],
        "order_id": "order_DESoU0U4ikYA19",
        "refund_status": null,
        "status": "captured",
        "tax": null,
        "token_id": "token_MOfFlFTC1CBDOi",
        "vpa": null,
        "wallet": null
      }
    }
  }
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/payments "Payment Failed", Netbanking. */
export const WEBHOOK_PAYMENT_FAILED = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "payment.failed",
  "contains": [
    "payment"
  ],
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_DEAU825sJlCbGa",
        "entity": "payment",
        "amount": 50000,
        "currency": "INR",
        "status": "failed",
        "order_id": "order_DEATVTRRctwEGb",
        "invoice_id": null,
        "international": false,
        "method": "netbanking",
        "amount_refunded": 0,
        "refund_status": null,
        "captured": false,
        "description": null,
        "card_id": null,
        "bank": "HDFC",
        "wallet": null,
        "vpa": null,
        "email": "<email>",
        "contact": "<phone>",
        "notes": [],
        "fee": null,
        "tax": null,
        "error_code": "BAD_REQUEST_ERROR",
        "error_description": "Payment failed",
        "error_source": "bank",
        "error_step": "payment_authorization",
        "error_reason": "payment_failed",
        "acquirer_data": {
          "bank_transaction_id": null
        },
        "created_at": 1567610214
      }
    }
  },
  "created_at": 1567610215
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/payments "Payment Failed", UPI. */
export const WEBHOOK_PAYMENT_FAILED_UPI = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "payment.failed",
  "contains": [
    "payment"
  ],
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_DESyzxuld02Zul",
        "entity": "payment",
        "amount": 100,
        "currency": "INR",
        "status": "failed",
        "order_id": "order_DESxiijbl9xjDB",
        "invoice_id": null,
        "international": false,
        "method": "upi",
        "amount_refunded": 0,
        "refund_status": null,
        "captured": false,
        "description": null,
        "card_id": null,
        "bank": null,
        "wallet": null,
        "vpa": "gaurav.kumar@upi",
        "email": "<email>",
        "contact": "+919876543210",
        "notes": [],
        "fee": null,
        "tax": null,
        "error_code": "BAD_REQUEST_ERROR",
        "error_description": "Payment failed",
        "error_source": "issuer",
        "error_step": "payment_authorization",
        "error_reason": "payment_failed",
        "acquirer_data": {
          "rrn": null
        },
        "created_at": 1567675356,
        "upi": {
          "payer_account_type": "credit_card",
          "vpa": "gaurav.kumar@upi",
          "flow": "intent"
        }
      }
    }
  },
  "created_at": 1567675356
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/orders "Order Paid", Netbanking. */
export const WEBHOOK_ORDER_PAID = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "order.paid",
  "contains": [
    "payment",
    "order"
  ],
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_DESlfW9H8K9uqM",
        "entity": "payment",
        "amount": 100,
        "currency": "INR",
        "status": "captured",
        "order_id": "order_DESlLckIVRkHWj",
        "invoice_id": null,
        "international": false,
        "method": "netbanking",
        "amount_refunded": 0,
        "refund_status": null,
        "captured": true,
        "description": null,
        "card_id": null,
        "bank": "HDFC",
        "wallet": null,
        "vpa": null,
        "email": "gaurav.kumar@example.com",
        "contact": "+919876543210",
        "notes": [],
        "fee": 2,
        "tax": 0,
        "error_code": null,
        "error_description": null,
        "created_at": 1567674599
      }
    },
    "order": {
      "entity": {
        "id": "order_DESlLckIVRkHWj",
        "entity": "order",
        "amount": 100,
        "amount_paid": 100,
        "amount_due": 0,
        "currency": "INR",
        "receipt": "rcptid #1",
        "offer_id": null,
        "status": "paid",
        "attempts": 1,
        "notes": [],
        "created_at": 1567674581
      }
    }
  },
  "created_at": 1567674606
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/refunds "Refund Created". */
export const WEBHOOK_REFUND_CREATED = String.raw`{
  "entity": "event",
  "account_id": "acc_E7OQJcEANmBHTC",
  "event": "refund.created",
  "contains": [
    "refund",
    "payment"
  ],
  "payload": {
    "refund": {
      "entity": {
        "id": "rfnd_FS8TWyPrCsa0OB",
        "entity": "refund",
        "amount": 50000,
        "currency": "INR",
        "payment_id": "pay_FPoJKWQQ8lK13n",
        "notes": {
          "comment": "Customer Notes for Webhooks."
        },
        "receipt": null,
        "acquirer_data": {
          "arn": null
        },
        "created_at": 1597734071,
        "batch_id": null,
        "status": "processed",
        "speed_processed": "normal",
        "speed_requested": "optimum"
      }
    },
    "payment": {
      "entity": {
        "id": "pay_FPoJKWQQ8lK13n",
        "entity": "payment",
        "amount": 500000,
        "currency": "INR",
        "base_amount": 500000,
        "status": "captured",
        "order_id": "order_FPoIeimWki9j8A",
        "invoice_id": null,
        "international": false,
        "method": "netbanking",
        "amount_refunded": 190000,
        "amount_transferred": 0,
        "refund_status": "partial",
        "captured": true,
        "description": null,
        "card_id": null,
        "bank": "HDFC",
        "wallet": null,
        "vpa": null,
        "email": "gaurav.kumar@example.com",
        "contact": "+919000090000",
        "notes": [],
        "fee": 11800,
        "tax": 1800,
        "error_code": null,
        "error_description": null,
        "error_source": null,
        "error_step": null,
        "error_reason": null,
        "acquirer_data": {
          "bank_transaction_id": "4827433"
        },
        "created_at": 1597226379
      }
    }
  },
  "created_at": 1597734071
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/refunds "Refund Processed". */
export const WEBHOOK_REFUND_PROCESSED = String.raw`{
  "entity": "event",
  "account_id": "acc_E7OQJcEANmBHTC",
  "event": "refund.processed",
  "contains": [
    "refund",
    "payment"
  ],
  "payload": {
    "refund": {
      "entity": {
        "id": "rfnd_FS8TWyPrCsa0OB",
        "entity": "refund",
        "amount": 50000,
        "currency": "INR",
        "payment_id": "pay_FPoJKWQQ8lK13n",
        "notes": {
          "comment": "Customer Notes for Webhooks."
        },
        "receipt": null,
        "acquirer_data": {
          "arn": null
        },
        "created_at": 1597734071,
        "batch_id": null,
        "status": "processed",
        "speed_processed": "normal",
        "speed_requested": "optimum"
      }
    },
    "payment": {
      "entity": {
        "id": "pay_FPoJKWQQ8lK13n",
        "entity": "payment",
        "amount": 500000,
        "currency": "INR",
        "base_amount": 500000,
        "status": "captured",
        "order_id": "order_FPoIeimWki9j8A",
        "invoice_id": null,
        "international": false,
        "method": "netbanking",
        "amount_refunded": 190000,
        "amount_transferred": 0,
        "refund_status": "partial",
        "captured": true,
        "description": null,
        "card_id": null,
        "bank": "HDFC",
        "wallet": null,
        "vpa": null,
        "email": "gaurav.kumar@example.com",
        "contact": "+919000090000",
        "notes": [],
        "fee": 11800,
        "tax": 1800,
        "error_code": null,
        "error_description": null,
        "error_source": null,
        "error_step": null,
        "error_reason": null,
        "acquirer_data": {
          "bank_transaction_id": "4827433"
        },
        "created_at": 1597226379
      }
    }
  },
  "created_at": 1597734071
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/refunds "Refund Failed". */
export const WEBHOOK_REFUND_FAILED = String.raw`{
  "entity": "event",
  "account_id": "acc_E7OQJcEANmBHTC",
  "event": "refund.failed",
  "contains": [
    "refund",
    "payment"
  ],
  "payload": {
    "refund": {
      "entity": {
        "id": "rfnd_FS8TWyPrCsa0OB",
        "entity": "refund",
        "amount": 50000,
        "currency": "INR",
        "payment_id": "pay_FPoJKWQQ8lK13n",
        "notes": {
          "comment": "Customer Notes for Webhooks."
        },
        "receipt": null,
        "acquirer_data": {
          "arn": null
        },
        "created_at": 1597734071,
        "batch_id": null,
        "status": "failed",
        "speed_processed": "normal",
        "speed_requested": "optimum"
      }
    },
    "payment": {
      "entity": {
        "id": "pay_FPoJKWQQ8lK13n",
        "entity": "payment",
        "amount": 500000,
        "currency": "INR",
        "base_amount": 500000,
        "status": "captured",
        "order_id": "order_FPoIeimWki9j8A",
        "invoice_id": null,
        "international": false,
        "method": "netbanking",
        "amount_refunded": 190000,
        "amount_transferred": 0,
        "refund_status": "partial",
        "captured": true,
        "description": null,
        "card_id": null,
        "bank": "HDFC",
        "wallet": null,
        "vpa": null,
        "email": "gaurav.kumar@example.com",
        "contact": "+919000090000",
        "notes": [],
        "fee": 11800,
        "tax": 1800,
        "error_code": null,
        "error_description": null,
        "error_source": null,
        "error_step": null,
        "error_reason": null,
        "acquirer_data": {
          "bank_transaction_id": "4827433"
        },
        "created_at": 1597226379
      }
    }
  },
  "created_at": 1597734071
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/subscriptions "subscription.charged". */
export const WEBHOOK_SUBSCRIPTION_CHARGED = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "subscription.charged",
  "contains": [
    "subscription",
    "payment"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_DEX6xcJ1HSW4CR",
        "entity": "subscription",
        "plan_id": "plan_BvrFKjSxauOH7N",
        "customer_id": "cust_C0WlbKhp3aLA7W",
        "status": "active",
        "type": 2,
        "current_start": 1570213800,
        "current_end": 1572892200,
        "ended_at": null,
        "quantity": 1,
        "notes": {
          "Important": "Notes for Internal Reference"
        },
        "charge_at": 1572892200,
        "start_at": 1570213800,
        "end_at": 1599244200,
        "auth_attempts": 0,
        "total_count": 12,
        "paid_count": 1,
        "customer_notify": true,
        "created_at": 1567689895,
        "expire_by": 1567881000,
        "short_url": null,
        "has_scheduled_changes": false,
        "change_scheduled_at": null,
        "source": "api",
        "offer_id":"offer_JHD834hjbxzhd38d",
        "remaining_count": 11
      }
    },
    "payment": {
      "entity": {
        "id": "pay_DEXFWroJ6LikKT",
        "entity": "payment",
        "amount": 100000,
        "currency": "INR",
        "status": "captured",
        "order_id": "order_DEXFWXwO24pDxH",
        "invoice_id": "inv_DEXFWVuM6rPqlK",
        "international": false,
        "method": "card",
        "amount_refunded": 0,
        "amount_transferred": 0,
        "refund_status": null,
        "captured": "1",
        "description": "Recurring Payment via Subscription",
        "card_id": "card_DEXFX0KGtXexrH",
        "card": {
          "id": "card_DEXFX0KGtXexrH",
          "entity": "card",
          "name": "Gaurav Kumar",
          "last4": "5558",
          "network": "MasterCard",
          "type": "credit",
          "issuer": "KARB",
          "international": false,
          "emi": false,
          "expiry_month": 2,
          "expiry_year": 2022
        },
        "bank": null,
        "wallet": null,
        "vpa": null,
        "email": "gaurav.kumar@example.com",
        "contact": "+919876543210",
        "customer_id": "cust_C0WlbKhp3aLA7W",
        "token_id": null,
        "notes": [],
        "fee": 2900,
        "tax": 0,
        "error_code": null,
        "error_description": null,
        "created_at": 1567690382
      }
    }
  },
  "created_at": 1567690383
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/subscriptions "subscription.authenticated". */
export const WEBHOOK_SUBSCRIPTION_AUTHENTICATED = String.raw`{
  "entity": "event",
  "account_id": "acc_F5Motm2sJ5Fomd",
  "event": "subscription.authenticated",
  "contains": [
    "subscription"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_F5aa7VaVXtXh80",
        "entity": "subscription",
        "plan_id": "plan_F5Zu0nrXVhHV2m",
        "customer_id": "cust_F5ZuzTm0cqYpzp",
        "status": "authenticated",
        "current_start": null,
        "current_end": null,
        "ended_at": null,
        "quantity": 1,
        "notes": [],
        "charge_at": 1593109800,
        "start_at": 1593109800,
        "end_at": 1598380200,
        "auth_attempts": 0,
        "total_count": 3,
        "paid_count": 0,
        "customer_notify": true,
        "created_at": 1592811228,
        "expire_by": null,
        "short_url": null,
        "has_scheduled_changes": false,
        "change_scheduled_at": null,
        "source": "api",
        "offer_id":"offer_JHD834hjbxzhd38d",
        "remaining_count": 3
      }
    }
  },
  "created_at": 1592811255
}`;

/** Verbatim sample, razorpay.com/docs/webhooks/payloads/refunds "Refund Speed Changed". */
export const WEBHOOK_REFUND_SPEED_CHANGED = String.raw`{
  "entity": "event",
  "account_id": "acc_BTIVttuC4ACVOz",
  "event": "refund.speed_changed",
  "contains": [
    "refund",
    "payment"
  ],
  "payload": {
    "refund": {
      "entity": {
        "id": "rfnd_EcPN8eJuzH5Yaz",
        "entity": "refund",
        "amount": 200,
        "currency": "INR",
        "payment_id": "pay_EcPJsxu8cSzOK6",
        "notes": [],
        "receipt": null,
        "acquirer_data": {},
        "created_at": 1586439890,
        "status": "processed",
        "speed_processed": "normal",
        "speed_requested": "optimum"
      }
    },
    "payment": {
      "entity": {
        "id": "pay_EcPJsxu8cSzOK6",
        "entity": "payment",
        "amount": 500000,
        "currency": "INR",
        "base_amount": 500000,
        "status": "captured",
        "order_id": "order_FPoIeimWki9j8A",
        "invoice_id": null,
        "international": false,
        "method": "netbanking",
        "amount_refunded": 190000,
        "amount_transferred": 0,
        "refund_status": "partial",
        "captured": true,
        "description": null,
        "card_id": null,
        "bank": "HDFC",
        "wallet": null,
        "vpa": null,
        "email": "gaurav.kumar@example.com",
        "contact": "+919977665544",
        "notes": [],
        "fee": 11800,
        "tax": 1800,
        "error_code": null,
        "error_description": null,
        "error_source": null,
        "error_step": null,
        "error_reason": null,
        "acquirer_data": {
          "bank_transaction_id": "4827433"
        },
        "created_at": 1585226379
      }
    },
    "created_at": 1586439890
  }
}`;

/** Verbatim sample, razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps "Success Callback". */
export const CHECKOUT_SUCCESS_CALLBACK = String.raw`{
  "razorpay_payment_id": "pay_29QQoUBi66xm2f",
  "razorpay_order_id": "order_9A33XWu170gUtm",
  "razorpay_signature": "9ef4dffbfd84f1318f6739a3ce19f9d85851857ae648f114332d8401e0949a3d"
}`;
