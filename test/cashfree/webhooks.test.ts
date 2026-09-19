import { createHash, createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ChargeKind,
  ChargeStatus,
  Environment,
  ErrorCode,
  EventType,
  PaymentMethod,
  Provider,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { CashfreeProvider } from '../../src/providers/cashfree/index.js';
import type { SubscriptionEvent } from '../../src/schemas.js';

const CLIENT_SECRET = 'test_client_secret_ZZ9_do_not_leak';
const WEBHOOK_SECRET = 'whsec_do_not_leak_987';
/** 2026-11-17 10:30 IST. */
const NOW = new Date('2026-11-17T05:00:00.000Z');
/** The format of `x-webhook-timestamp` is not documented; any string signs the same way. */
const TIMESTAMP = '1754550000000';

function provider(webhookSecret?: string): CashfreeProvider {
  return new CashfreeProvider(
    { clientId: 'id', clientSecret: CLIENT_SECRET, environment: Environment.Test, ...(webhookSecret ? { webhookSecret } : {}) },
    { now: () => NOW },
  );
}

/** Independent of the library: base64(HMAC-SHA256(secret, timestamp + rawBody)) [guide:webhook-signature]. */
function sign(rawBody: string, secret = CLIENT_SECRET, timestamp = TIMESTAMP): string {
  return createHmac('sha256', secret).update(timestamp + rawBody).digest('base64');
}

function signedHeaders(rawBody: string, secret = CLIENT_SECRET, timestamp = TIMESTAMP): Record<string, string> {
  return { 'x-webhook-signature': sign(rawBody, secret, timestamp), 'x-webhook-timestamp': timestamp };
}

function parse(rawBody: string, webhookSecret?: string): SubscriptionEvent {
  const events = provider(webhookSecret).parseWebhook({ rawBody, headers: signedHeaders(rawBody, webhookSecret ?? CLIENT_SECRET) });
  expect(events).toHaveLength(1);
  return events[0] as SubscriptionEvent;
}

function thrown(fn: () => unknown): SubscriptionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected a throw');
}

function edit(rawBody: string, change: (body: any) => void): string {
  const parsed = JSON.parse(rawBody);
  change(parsed);
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// Fixtures: the documentation's sample payloads, verbatim (see ref/facts/cashfree.md section 9.6).
// ---------------------------------------------------------------------------

/** [guide:webhooks] SUBSCRIPTION_STATUS_CHANGED, version 2025-01-01. Verbatim, including its indentation: the signature covers these exact bytes. */
const STATUS_CHANGED_2025 = `{
"data": {
"subscription_details": {
  "cf_subscription_id": "23639356",
  "subscription_id": "mozuyYwUCbWEfJVVRLi",
  "subscription_status": "BANK_APPROVAL_PENDING",
  "subscription_expiry_time": "2055-08-07T10:30:46",
  "subscription_first_charge_time": null,
  "subscription_tags": null,
  "next_schedule_date": null
},
"customer_details": {
  "customer_name": null,
  "customer_email": "john@dummy.com",
  "customer_phone": "9900000000"
},
"plan_details": {
  "plan_id": "mozuyYwUCbWEfJVVRLi",
  "plan_name": "6Msuj2mttuf2F5P1FYVSet",
  "plan_type": "ON_DEMAND",
  "plan_max_cycles": 0,
  "plan_recurring_amount": null,
  "plan_max_amount": 399.00,
  "plan_interval_type": null,
  "plan_intervals": null,
  "plan_currency": "INR",
  "plan_note": null,
  "plan_status": null
},
"authorization_details": {
  "authorization_amount": 2.00,
  "authorization_amount_refund": false,
  "approve_by_time": "2025-09-06T10:30:47",
  "authorization_reference": "6ba74ac2b047424da95591xxxxx[at]xxxx",
  "authorization_time": "2025-08-07T10:31:36",
  "authorization_status": "PENDING",
  "payment_id": "49988270",
  "payment_method": {
    "upi": {
      "channel": "link",
      "upi_id": "9910000000@ybl",
      "upi_instrument": "",
      "upi_instrument_number": "",
      "upi_payer_account_number": "",
      "upi_payer_ifsc": ""
    }
  },
  "payment_group": "upi"
},
"payment_gateway_details": {
  "gateway_name": "CASHFREE",
  "gateway_subscription_id": "23639356",
  "gateway_plan_id": "mozuyYwUCbWEfJVVRLi",
  "gateway_auth_id": "6ba74ac2b047424da95591xxxxx[at]xxxx"
}
},
"event_time": "2025-08-07T10:31:35+05:30",
"type": "SUBSCRIPTION_STATUS_CHANGED"
}`;

/** [guide:webhooks] SUBSCRIPTION_STATUS_CHANGED, version 2023-08-01. Verbatim, including its indentation: the signature covers these exact bytes. */
const STATUS_CHANGED_2023 = `{
"data": {
    "subscription_details": {
        "cf_subscription_id": "123456",
        "subscription_id": "Demo_Subscription",
        "subscription_status": "ACTIVE",
        "subscription_expiry_time": "2024-01-14T23:00:08+05:30",
        "subscription_first_charge_time": "2024-01-10T23:00:08+05:30"
    },
    "customer_details": {
        "customer_name": "john",
        "customer_email": "john@dummy.com",
        "customer_phone": "9900000000"
    },
    "plan_details": {
        "plan_id": "plan12345",
        "plan_name": "Plan Name",
        "plan_type": "ON_DEMAND",
        "plan_max_cycles": 10,
        "plan_recurring_amount": 100.00,
        "plan_max_amount": 1000.00,
        "plan_currency": "INR",
        "plan_note": "Note",
        "plan_status": "ACTIVE"
    },
    "authorization_details": {
        "authorizationAmount": 1.00,
        "authorizationAmountRefund": true,
        "approveByTime": "2025-09-06T16:44:48",
        "authorizationReference": "544edde057f34ce588627axxxxx[at]xxxx",
        "authorizationTime": "2025-08-07T16:46:06",
        "authorizationStatus": "PENDING",
        "paymentId": "50088288",
        "paymentMethod": "upi",
        "instrumentId": "xxxxx@xxxx"
    },
    "payment_gateway_details": {
        "gateway_name": "CASHFREE",
        "gateway_subscription_id": "Demo_Subscription",
        "gateway_plan_id": "plan12345",
        "gateway_auth_id": "6595231908096894505959"
    }
},
"event_time": "2023-01-03T11:16:10+05:30",
"type": "SUBSCRIPTION_STATUS_CHANGED"
}`;

/** [guide:webhooks] SUBSCRIPTION_AUTH_STATUS, version 2026-01-01 (a FAILED authorisation). Verbatim, including its indentation: the signature covers these exact bytes. */
const AUTH_STATUS_2026 = `{
 "data": {
   "payment_id": "ab-SUBV2ODRFhdJuHlcQYyFw-1",
   "cf_payment_id": "49988825",
   "cf_txn_id": "4213159266",
   "cf_order_id": "4519691525",
   "subscription_id": "mozth7smWGCCqPRaSv7",
   "cf_subscription_id": "23639858",
   "payment_type": "AUTH",
   "subscription_details": {
     "cf_subscription_id": "23639858",
     "subscription_id": "mozth7smWGCCqPRaSv7",
     "subscription_status": "ACTIVE",
     "subscription_expiry_time": "2047-07-30T13:24:54",
     "subscription_first_charge_time": null,
     "subscription_tags": {
       "company": "Cashfree",
       "name": "Payment link"
     },
     "next_schedule_date": null
   },
   "authorization_details": {
     "authorization_amount": 2.00,
     "authorization_amount_refund": false,
     "approve_by_time": "",
     "authorization_reference": "cce92d335be0467693c020xxxxx[at]xxxx",
     "authorization_time": "2025-08-07T10:34:23+05:30",
     "authorization_status": "FAILED",
     "payment_id": "ab-SUBV2ODRFhdJuHlcQYyFw-1",
     "payment_method": {
       "upi": {
         "channel": "link",
         "upi_id": "9910000000@ybl",
         "upi_instrument": "",
         "upi_instrument_number": "",
         "upi_payer_account_number": "",
         "upi_payer_ifsc": ""
       }
     },
     "payment_group": "upi"
   },
   "payment_amount": 2.00,
   "payment_currency": "INR",
   "payment_schedule_date": "",
   "payment_initiated_date": "2025-08-07T10:33:56+05:30",
   "payment_remarks": "auth payment",
   "retry_attempts": 0,
   "failure_details": {
     "failure_reason": "DEBIT HAS BEEN FAILED"
   },
   "payment_status": "FAILED",
   "payment_gateway_details": {
     "gateway_name": "CASHFREE",
     "gateway_subscription_id": "23639858",
     "gateway_payment_id": "49988825"
   }
 },
 "event_time": "2025-08-07T10:34:23+05:30",
 "type": "SUBSCRIPTION_AUTH_STATUS"
}`;

/** [guide:webhooks] SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED, version 2026-01-01. Verbatim, including its indentation: the signature covers these exact bytes. */
const NOTIFICATION_2026 = `{
"data": {
"payment_id": "ab-SUBV2ODR683gV1CXF85ev-1",
"cf_payment_id": "49970855",
"cf_txn_id": null,
"cf_order_id": "",
"subscription_id": "moziva9hyjiLtCuGN74",
"cf_subscription_id": "22390006",
"payment_type": "CHARGE",
"subscription_details": {
  "cf_subscription_id": "22390006",
  "subscription_id": "moziva9hyjiLtCuGN74",
  "subscription_status": "ACTIVE",
  "subscription_expiry_time": "2047-07-30T13:24:54",
  "subscription_first_charge_time": null,
  "subscription_tags": {
    "company": "Cashfree",
    "name": "Payment link"
  },
  "next_schedule_date": null
},
"authorization_details": {
  "authorization_amount": 399.00,
  "authorization_amount_refund": false,
  "approve_by_time": "",
  "authorization_reference": null,
  "authorization_time": "",
  "authorization_status": null,
  "payment_id": "ab-SUBV2ODR683gV1CXF85ev-1",
  "payment_method": null,
  "payment_group": null
},
"payment_amount": 399.00,
"payment_currency": "INR",
"payment_schedule_date": "2025-08-08T12:00:00+05:30",
"payment_initiated_date": "2025-08-07T09:08:09+05:30",
"payment_remarks": null,
"retry_attempts": 0,
"failure_details": {
  "failure_reason": null
},
"payment_status": "INITIALIZED",
"payment_gateway_details": {
  "gateway_name": "CASHFREE",
  "gateway_subscription_id": "22390006",
  "gateway_payment_id": "49970855"
}
},
"event_time": "2025-08-07T09:51:07+05:30",
"type": "SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED"
}`;

/** [guide:webhooks] SUBSCRIPTION_PAYMENT_SUCCESS, version 2026-01-01 (an AUTH payment whose amount is kept). Verbatim, including its indentation: the signature covers these exact bytes. */
const PAYMENT_SUCCESS_2026 = `{
"data": {
"payment_id": "ab-SUBV2ODRc5Dl2meCr7Iui-1",
"cf_payment_id": "49914526",
"cf_txn_id": "4212435861",
"cf_order_id": "4518936510",
"subscription_id": "moznV33AssPd6vXsSm2",
"cf_subscription_id": "23601811",
"payment_type": "AUTH",
"subscription_details": {
  "cf_subscription_id": "23601811",
  "subscription_id": "moznV33AssPd6vXsSm2",
  "subscription_status": "ACTIVE",
  "subscription_expiry_time": "2047-07-30T13:24:54",
  "subscription_first_charge_time": null,
  "subscription_tags": {
    "company": "Cashfree",
    "name": "Payment link"
  },
  "next_schedule_date": null
},
"authorization_details": {
  "authorization_amount": 2.00,
  "authorization_amount_refund": false,
  "approve_by_time": "",
  "authorization_reference": "427b608f83ad4cbdb6d472xxxxx[at]xxxx",
  "authorization_time": "2025-08-07T05:53:22+05:30",
  "authorization_status": "ACTIVE",
  "payment_id": "ab-SUBV2ODRc5Dl2meCr7Iui-1",
  "payment_method": {
    "upi": {
      "channel": "link",
      "upi_id": "8100000000@ybl",
      "upi_instrument": "",
      "upi_instrument_number": "",
      "upi_payer_account_number": "",
      "upi_payer_ifsc": ""
    }
  },
  "payment_group": "upi"
},
"payment_amount": 2.00,
"payment_currency": "INR",
"payment_schedule_date": "",
"payment_initiated_date": "2025-08-07T05:52:21+05:30",
"payment_remarks": "auth payment",
"retry_attempts": 0,
"failure_details": {
  "failure_reason": null
},
"payment_status": "SUCCESS",
"payment_gateway_details": {
  "gateway_name": "CASHFREE",
  "gateway_subscription_id": "23601811",
  "gateway_payment_id": "49914526"
}
},
"event_time": "2025-08-07T05:53:21+05:30",
"type": "SUBSCRIPTION_PAYMENT_SUCCESS"
}`;

/** [guide:webhooks] SUBSCRIPTION_PAYMENT_FAILED, version 2026-01-01. Verbatim, including its indentation: the signature covers these exact bytes. */
const PAYMENT_FAILED_2026 = `{
"data": {
"payment_id": "ab-SUBV2ODRIeYlFEhMHfS0M-1",
"cf_payment_id": "49585655",
"cf_txn_id": "4212555720",
"cf_order_id": "4519061918",
"subscription_id": "mozh4iRHSsjre7GkDNz",
"cf_subscription_id": "22393526",
"payment_type": "CHARGE",
"subscription_details": {
  "cf_subscription_id": "22393526",
  "subscription_id": "mozh4iRHSsjre7GkDNz",
  "subscription_status": "ACTIVE",
  "subscription_expiry_time": "2047-07-30T13:24:54",
  "subscription_first_charge_time": null,
  "subscription_tags": {
    "company": "Cashfree",
    "name": "Payment link"
  },
  "next_schedule_date": null
},
"authorization_details": {
  "authorization_amount": 399.00,
  "authorization_amount_refund": false,
  "approve_by_time": "",
  "authorization_reference": "a7d6101a7d9340269f070dxxxxx[at]xxxx",
  "authorization_time": "2025-07-25T22:37:53+05:30",
  "authorization_status": "ACTIVE",
  "payment_id": "ab-SUBV2ODRIeYlFEhMHfS0M-1",
  "payment_method": {
    "upi": {
      "channel": "link",
      "upi_id": "9910000000@ybl",
      "upi_instrument": "",
      "upi_instrument_number": "",
      "upi_payer_account_number": "",
      "upi_payer_ifsc": ""
    }
  },
  "payment_group": "upi"
},
"payment_amount": 399.00,
"payment_currency": "INR",
"payment_schedule_date": "2025-08-07T12:00:00+05:30",
"payment_initiated_date": "2025-08-06T05:02:41+05:30",
"payment_remarks": null,
"retry_attempts": 0,
"failure_details": {
  "failure_reason": "DEBIT FAILED | Insufficient Funds In Customer (Remitter) Account"
},
"payment_status": "FAILED",
"payment_gateway_details": {
  "gateway_name": "CASHFREE",
  "gateway_subscription_id": "22393526",
  "gateway_payment_id": "49585655"
}
},
"event_time": "2025-08-07T10:24:45+05:30",
"type": "SUBSCRIPTION_PAYMENT_FAILED"
}`;

/** [guide:webhooks] SUBSCRIPTION_PAYMENT_FAILED, version 2023-08-01. Verbatim, including its indentation: the signature covers these exact bytes. */
const PAYMENT_FAILED_2023 = `{
"data": {
    "payment_id": "12345",
    "cf_payment_id": "67890",
    "cf_txn_id": "789012",
    "cf_order_id": "98765",
    "subscription_id": "sub12345",
    "cf_subscription_id": "sub67890",
    "payment_type": "DEBIT_CARD",
    "authorization_details": {
        "authorization_amount": 100,
        "authorization_amount_refund": true,
        "approve_by_time": "2024-07-18T16:09:50+05:30",
        "authorization_reference": "6595231908096894505959",
        "authorization_time": "2024-07-18T16:09:51",
        "authorization_status": "ACTIVE",
        "payment_id": "123",
        "payment_method": "DEBIT_CARD",
        "instrument_id": "hsdg9"
    },
    "payment_amount": 200,
    "payment_schedule_date": "2024-07-20",
    "payment_initiated_date": "2024-07-20",
    "payment_remarks": "payment",
    "retry_attempts": 0,
    "failureDetails": {
        "failureReason": "Insufficient balance"
    },
    "payment_status": "FAILED",
    "payment_gateway_details": {
        "gateway_name": "CASHFREE",
        "gateway_subscription_id": "Demo_Subscription",
        "gateway_payment_id": "payment12345"
    }
},
"event_time": "2024-07-20T11:16:10+05:30",
"type": "SUBSCRIPTION_PAYMENT_FAILED"
}`;

/** [guide:webhooks] SUBSCRIPTION_PAYMENT_CANCELLED, version 2026-01-01. Verbatim, including its indentation: the signature covers these exact bytes. */
const PAYMENT_CANCELLED_2026 = `{
"data": {
"payment_id": "433563_33_1754492527395",
"cf_payment_id": "2011332",
"cf_txn_id": null,
"cf_order_id": "",
"subscription_id": "subTestIdOndemand_2025080615020470",
"cf_subscription_id": "1220385",
"payment_type": "CHARGE",
"subscription_details": {
  "cf_subscription_id": "1220385",
  "subscription_id": "subTestIdOndemand_2025080615020470",
  "subscription_status": "ACTIVE",
  "subscription_expiry_time": "2047-07-30T13:24:54",
  "subscription_first_charge_time": null,
  "subscription_tags": {
    "company": "Cashfree",
    "name": "Payment link"
  },
  "next_schedule_date": null
},
"authorization_details": {
  "authorization_amount": 1.00,
  "authorization_amount_refund": false,
  "approve_by_time": "",
  "authorization_reference": null,
  "authorization_time": "",
  "authorization_status": null,
  "payment_id": "433563_33_1754492527395",
  "payment_method": null,
  "payment_group": null
},
"payment_amount": 1.00,
"payment_currency": "INR",
"payment_schedule_date": "2025-08-08T12:00:00+05:30",
"payment_initiated_date": "2025-08-06T20:32:07+05:30",
"payment_remarks": null,
"retry_attempts": 0,
"failure_details": {
  "failure_reason": null
},
"payment_status": "CANCELLED",
"payment_gateway_details": {
  "gateway_name": "CASHFREE",
  "gateway_subscription_id": "1220385",
  "gateway_payment_id": "2011332"
}
},
"event_time": "2025-08-06T20:32:07+05:30",
"type": "SUBSCRIPTION_PAYMENT_CANCELLED"
}`;

/** [guide:webhooks] SUBSCRIPTION_REFUND_STATUS, version 2025-01-01. Verbatim, including its indentation: the signature covers these exact bytes. */
const REFUND_STATUS_2025 = `{
"data": {
"payment_id": "yCzJxeT2aXDqI",
"cf_payment_id": "49778199",
"refund_id": "WHOqiwy05P1l0",
"cf_refund_id": "SUB_21ebb4bf-e84f-4afa-bb09-07aac433abe4",
"refund_amount": 1000.00,
"refund_speed": "STANDARD",
"refund_note": "Tesg Refund",
"refund_status": "SUCCESS",
"failure_details": "",
"refund_gateway_details": {
  "gateway_name": "CASHFREE",
  "gateway_payment_id": "49778199",
  "gateway_refund_id": "SUB_21ebb4bf-e84f-4afa-bb09-07aac433abe4"
}
},
"event_time": "2025-08-06T17:20:02+05:30",
"type": "SUBSCRIPTION_REFUND_STATUS"
}`;

/** [guide:webhooks] SUBSCRIPTION_CARD_EXPIRY_REMINDER, version 2025-01-01. Verbatim, including its indentation: the signature covers these exact bytes. */
const CARD_EXPIRY_2025 = `{
"data": {
    "subscription_status_webhook": {
        "subscription_details": {
            "cf_subscription_id": "23661347",
            "subscription_id": "SUB_TEST_1754550382119",
            "subscription_status": "ACTIVE",
            "subscription_expiry_time": "2050-12-31T00:00:00",
            "subscription_first_charge_time": "2025-09-30T00:00:00",
            "subscription_tags": {
                "next_schedule_date": "2025-09-30T00:10:00"
            }
        },
        "customer_details": {
            "customer_name": "John Doe",
            "customer_email": "john@cashfree.com",
            "customer_phone": "9090909090"
        },
        "plan_details": {
            "plan_id": "PLAN_1754550139964",
            "plan_name": "MY_PLAN",
            "plan_type": "PERIODIC",
            "plan_max_cycles": 2,
            "plan_recurring_amount": 5,
            "plan_max_amount": 1000,
            "plan_interval_type": "MONTH",
            "plan_intervals": 1,
            "plan_currency": null,
            "plan_note": null,
            "plan_status": null
        },
        "authorization_details": {
            "authorizationAmount": 1,
            "authorizationAmountRefund": false,
            "approveByTime": "2025-09-06T12:36:22",
            "authorizationReference": null,
            "authorizationTime": "2025-08-07T13:14:18",
            "authorizationStatus": "ACTIVE",
            "paymentId": "160594_178_1754552533131",
            "paymentMethod": "card",
            "instrumentId": null
        },
        "payment_gateway_details": {
            "gateway_name": "CASHFREE",
            "gateway_subscription_id": "23661347",
            "gateway_plan_id": "PLAN_1754550139964",
            "gateway_auth_id": null
        }
    },
    "card_expiry_date": "2025-09-30"
},
"event_time": "2025-09-24T02:00:09+05:30",
"type": "SUBSCRIPTION_CARD_EXPIRY_REMINDER"
}`;

/** [guide:webhooks] SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS (tab labelled 2025-01-01). Verbatim, including its indentation: the signature covers these exact bytes. */
const CONTROLLED_NOTIFICATION = `{
"data": {
"cf_notification_id": "3333",
"cf_order_id": "123456",
"cf_payment_id": "123456",
"cf_subscription_id": "7891011",
"cf_txn_id": "123456",
"notification_attempted_time": "2025-06-01T22:14:59+05:30",
"notification_completed_time": "2025-06-01T22:15:59+05:30",
"notification_failure_details": {
  "failure_reason": "",
  "failure_error_code": "",
  "failure_sub_error_code": ""
},
"notification_id": "notification-001",
"notification_initiated_time": "2025-06-01T22:14:58+05:30",
"notification_status": "SUCCESS",
"payment_amount": 1,
"payment_id": "test-payment-id",
"payment_remarks": "monthly charge",
"payment_status": "INITIALIZED",
"subscription_id": "test-subscription-id"
},
"event_time": "2025-06-01T22:15:59+05:30",
"type": "SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS"
}`;

/** [guide:webhooks] SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS (tab labelled 2025-01-01). Verbatim, including its indentation: the signature covers these exact bytes. */
const CONTROLLED_EXECUTION = `{
"data": {
"cf_execution_id": "3333",
"cf_order_id": "123456",
"cf_payment_id": "123456",
"cf_subscription_id": "7891011",
"cf_txn_id": "123456",
"execution_attempted_time": "2025-06-01T22:14:59+05:30",
"execution_completed_time": "2025-06-01T22:15:59+05:30",
"execution_id": "execution-001",
"execution_initiated_time": "2025-06-01T22:14:58+05:30",
"execution_status": "SUCCESS",
"failure_details": {
  "failure_reason": "",
  "failure_error_code": "",
  "failure_sub_error_code": ""
},
"payment_amount": 1,
"payment_id": "test-payment-id",
"payment_remarks": "",
"payment_status": "SUCCESS",
"subscription_id": "test-subscription-id"
},
"event_time": "2025-06-01T22:15:59+05:30",
"type": "SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS"
}`;

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

describe('parseWebhook signature', () => {
  it('accepts a signature computed as base64(HMAC-SHA256(secret, timestamp + rawBody))', () => {
    const events = provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: signedHeaders(PAYMENT_SUCCESS_2026) });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.SubscriptionCharged);
  });

  it('signs with the client secret by default (what the official SDK does) and with webhookSecret when set', () => {
    expect(() => provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: signedHeaders(PAYMENT_SUCCESS_2026, WEBHOOK_SECRET) })).toThrow(
      expect.objectContaining({ code: ErrorCode.SignatureInvalid }),
    );
    expect(parse(PAYMENT_SUCCESS_2026, WEBHOOK_SECRET).type).toBe(EventType.SubscriptionCharged);
    // ... and with an explicit webhook secret the client secret no longer verifies.
    const error = thrown(() =>
      provider(WEBHOOK_SECRET).parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: signedHeaders(PAYMENT_SUCCESS_2026, CLIENT_SECRET) }),
    );
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('rejects a wrong signature', () => {
    const error = thrown(() =>
      provider().parseWebhook({
        rawBody: PAYMENT_SUCCESS_2026,
        headers: { 'x-webhook-signature': sign(PAYMENT_SUCCESS_2026, 'another secret'), 'x-webhook-timestamp': TIMESTAMP },
      }),
    );
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('rejects a missing signature header', () => {
    const error = thrown(() => provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: { 'x-webhook-timestamp': TIMESTAMP } }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('rejects a missing timestamp header', () => {
    const error = thrown(() =>
      provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: { 'x-webhook-signature': sign(PAYMENT_SUCCESS_2026, CLIENT_SECRET, '') } }),
    );
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect(error.message).toContain('x-webhook-timestamp');
  });

  it('rejects a tampered body, even by one character', () => {
    const tampered = PAYMENT_SUCCESS_2026.replace('"payment_amount": 2.00', '"payment_amount": 9.00');
    expect(tampered).not.toBe(PAYMENT_SUCCESS_2026);
    const error = thrown(() => provider().parseWebhook({ rawBody: tampered, headers: signedHeaders(PAYMENT_SUCCESS_2026) }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('rejects a re-serialised body: the signature covers the exact bytes', () => {
    const reserialised = JSON.stringify(JSON.parse(PAYMENT_SUCCESS_2026));
    const error = thrown(() => provider().parseWebhook({ rawBody: reserialised, headers: signedHeaders(PAYMENT_SUCCESS_2026) }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('rejects a signature made for a different timestamp', () => {
    const error = thrown(() =>
      provider().parseWebhook({
        rawBody: PAYMENT_SUCCESS_2026,
        headers: { 'x-webhook-signature': sign(PAYMENT_SUCCESS_2026, CLIENT_SECRET, '1'), 'x-webhook-timestamp': TIMESTAMP },
      }),
    );
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('rejects a body-only signature (timestamp not prepended) and a hex-encoded signature', () => {
    const bodyOnly = createHmac('sha256', CLIENT_SECRET).update(PAYMENT_SUCCESS_2026).digest('base64');
    const hex = createHmac('sha256', CLIENT_SECRET).update(TIMESTAMP + PAYMENT_SUCCESS_2026).digest('hex');
    for (const signature of [bodyOnly, hex]) {
      const error = thrown(() =>
        provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': TIMESTAMP } }),
      );
      expect(error.code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('reads headers case-insensitively and accepts array values', () => {
    const headers = signedHeaders(PAYMENT_SUCCESS_2026);
    expect(
      provider().parseWebhook({
        rawBody: PAYMENT_SUCCESS_2026,
        headers: { 'X-Webhook-Signature': [headers['x-webhook-signature'] as string], 'X-WEBHOOK-TIMESTAMP': TIMESTAMP },
      }),
    ).toHaveLength(1);
  });

  it('parses nothing from a webhook whose signature fails, and leaks no secret or expected signature', () => {
    const headers = { 'x-webhook-signature': 'AAAA', 'x-webhook-timestamp': TIMESTAMP };
    const error = thrown(() => provider(WEBHOOK_SECRET).parseWebhook({ rawBody: 'not even json', headers }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    const everything = [error.message, JSON.stringify(error), inspect(error, { depth: 5, showHidden: true })].join('\n');
    expect(everything).not.toContain(CLIENT_SECRET);
    expect(everything).not.toContain(WEBHOOK_SECRET);
    expect(everything).not.toContain(sign('not even json', WEBHOOK_SECRET));
  });

  it('rejects a signed body that is not JSON, or has no type, or has a malformed data block', () => {
    for (const rawBody of ['plain text', '[]', JSON.stringify({ data: {}, event_time: 'x' }), JSON.stringify({ type: 'X', event_time: 'x', data: 'nope' })]) {
      const error = thrown(() => provider().parseWebhook({ rawBody, headers: signedHeaders(rawBody) }));
      expect(error.code).toBe(ErrorCode.UnexpectedResponse);
    }
  });

  it('rejects a signed known event whose data does not have the documented shape', () => {
    const broken = edit(PAYMENT_SUCCESS_2026, (body) => delete body.data.payment_status);
    const noSubscription = edit(STATUS_CHANGED_2025, (body) => delete body.data.subscription_details);
    for (const rawBody of [broken, noSubscription]) {
      const error = thrown(() => provider().parseWebhook({ rawBody, headers: signedHeaders(rawBody) }));
      expect(error.code).toBe(ErrorCode.UnexpectedResponse);
    }
  });
});

// ---------------------------------------------------------------------------
// Normalisation of every documented event
// ---------------------------------------------------------------------------

describe('parseWebhook events', () => {
  it('SUBSCRIPTION_STATUS_CHANGED (2025-01-01, BANK_APPROVAL_PENDING) is only an update: the mandate is not usable yet', () => {
    const event = parse(STATUS_CHANGED_2025);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_STATUS_CHANGED:23639356:BANK_APPROVAL_PENDING:2025-08-07T10:31:35+05:30',
      provider: Provider.Cashfree,
      type: EventType.SubscriptionUpdated,
      providerEventType: 'SUBSCRIPTION_STATUS_CHANGED',
      occurredAt: '2025-08-07T05:01:35.000Z',
      subscriptionId: 'mozuyYwUCbWEfJVVRLi',
    });
    expect(event.subscription).toMatchObject({
      id: 'mozuyYwUCbWEfJVVRLi',
      status: SubscriptionStatus.PendingAuthorization,
      providerStatus: 'BANK_APPROVAL_PENDING',
      scheduling: SchedulingMode.Merchant,
      planId: 'mozuyYwUCbWEfJVVRLi',
      // plan_max_amount 399.00 rupees
      maxAmount: 39900,
      paymentMethod: PaymentMethod.Upi,
      mandateEndsAt: '2055-08-07T05:00:46.000Z',
      customer: { email: 'john@dummy.com', phone: '9900000000' },
    });
    expect(event.raw).toMatchObject({ type: 'SUBSCRIPTION_STATUS_CHANGED' });
    expect(event.charge).toBeUndefined();
  });

  it('SUBSCRIPTION_STATUS_CHANGED (2023-08-01, ACTIVE, camelCase authorisation) is Activated', () => {
    const event = parse(STATUS_CHANGED_2023);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_STATUS_CHANGED:123456:ACTIVE:2023-01-03T11:16:10+05:30',
      type: EventType.SubscriptionActivated,
      subscriptionId: 'Demo_Subscription',
    });
    expect(event.subscription).toMatchObject({
      status: SubscriptionStatus.Active,
      maxAmount: 100000,
      paymentMethod: PaymentMethod.Upi,
      totalCycles: 10,
    });
  });

  it('SUBSCRIPTION_AUTH_STATUS (2026-01-01, FAILED) is AuthorizationFailed with the failed payment attached', () => {
    const event = parse(AUTH_STATUS_2026);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_AUTH_STATUS:49988825:FAILED:0:2025-08-07T10:34:23+05:30',
      type: EventType.SubscriptionAuthorizationFailed,
      providerEventType: 'SUBSCRIPTION_AUTH_STATUS',
      subscriptionId: 'mozth7smWGCCqPRaSv7',
      occurredAt: '2025-08-07T05:04:23.000Z',
    });
    expect(event.charge).toMatchObject({
      id: 'ab-SUBV2ODRFhdJuHlcQYyFw-1',
      subscriptionId: 'mozth7smWGCCqPRaSv7',
      status: ChargeStatus.Failed,
      providerStatus: 'FAILED',
      amount: 200,
      currency: 'INR',
      failureReason: 'DEBIT HAS BEEN FAILED',
      paymentMethod: PaymentMethod.Upi,
    });
    expect(event.charge?.paidAt).toBeUndefined();
    expect(event.charge?.scheduledAt).toBeUndefined();
  });

  it('SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED is ChargeScheduled (the pre-debit notice went out)', () => {
    const event = parse(NOTIFICATION_2026);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED:49970855:INITIALIZED:0:2025-08-07T09:51:07+05:30',
      type: EventType.SubscriptionChargeScheduled,
      subscriptionId: 'moziva9hyjiLtCuGN74',
    });
    expect(event.charge).toMatchObject({
      id: 'ab-SUBV2ODR683gV1CXF85ev-1',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Scheduled,
      amount: 39900,
      scheduledAt: '2025-08-08T06:30:00.000Z',
    });
    expect(event.charge?.paymentMethod).toBeUndefined();
  });

  it('SUBSCRIPTION_PAYMENT_SUCCESS is Charged; paidAt is the event time; a kept AUTH is the upfront charge', () => {
    const event = parse(PAYMENT_SUCCESS_2026);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_PAYMENT_SUCCESS:49914526:SUCCESS:0:2025-08-07T05:53:21+05:30',
      type: EventType.SubscriptionCharged,
      subscriptionId: 'moznV33AssPd6vXsSm2',
    });
    expect(event.charge).toMatchObject({
      id: 'ab-SUBV2ODRc5Dl2meCr7Iui-1',
      kind: ChargeKind.Upfront,
      status: ChargeStatus.Succeeded,
      amount: 200,
      paidAt: '2025-08-07T00:23:21.000Z',
      paymentMethod: PaymentMethod.Upi,
    });
  });

  it('SUBSCRIPTION_PAYMENT_FAILED (2026-01-01) is ChargeFailed with the bank reason', () => {
    const event = parse(PAYMENT_FAILED_2026);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_PAYMENT_FAILED:49585655:FAILED:0:2025-08-07T10:24:45+05:30',
      type: EventType.SubscriptionChargeFailed,
      subscriptionId: 'mozh4iRHSsjre7GkDNz',
    });
    expect(event.charge).toMatchObject({
      id: 'ab-SUBV2ODRIeYlFEhMHfS0M-1',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Failed,
      amount: 39900,
      scheduledAt: '2025-08-07T06:30:00.000Z',
      failureReason: 'DEBIT FAILED | Insufficient Funds In Customer (Remitter) Account',
    });
  });

  it('SUBSCRIPTION_PAYMENT_FAILED (2023-08-01) reads camelCase failureDetails, a date-only schedule and a string method', () => {
    const event = parse(PAYMENT_FAILED_2023);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_PAYMENT_FAILED:67890:FAILED:0:2024-07-20T11:16:10+05:30',
      type: EventType.SubscriptionChargeFailed,
      subscriptionId: 'sub12345',
    });
    expect(event.charge).toMatchObject({
      id: '12345',
      // payment_type "DEBIT_CARD" is not AUTH or CHARGE: treated as an ordinary debit.
      kind: ChargeKind.Recurring,
      amount: 20000,
      failureReason: 'Insufficient balance',
      // "2024-07-20" is a date: midnight IST.
      scheduledAt: '2024-07-19T18:30:00.000Z',
      paymentMethod: PaymentMethod.Card,
    });
  });

  it('SUBSCRIPTION_PAYMENT_CANCELLED is ChargeFailed carrying a cancelled charge', () => {
    const event = parse(PAYMENT_CANCELLED_2026);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_PAYMENT_CANCELLED:2011332:CANCELLED:0:2025-08-06T20:32:07+05:30',
      type: EventType.SubscriptionChargeFailed,
      providerEventType: 'SUBSCRIPTION_PAYMENT_CANCELLED',
      subscriptionId: 'subTestIdOndemand_2025080615020470',
    });
    expect(event.charge).toMatchObject({ id: '433563_33_1754492527395', status: ChargeStatus.Cancelled, amount: 100 });
  });

  it('SUBSCRIPTION_REFUND_STATUS (SUCCESS) is RefundSucceeded', () => {
    const event = parse(REFUND_STATUS_2025);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_REFUND_STATUS:SUB_21ebb4bf-e84f-4afa-bb09-07aac433abe4:SUCCESS:2025-08-06T17:20:02+05:30',
      type: EventType.RefundSucceeded,
      occurredAt: '2025-08-06T11:50:02.000Z',
    });
    expect(event.refund).toMatchObject({
      id: 'WHOqiwy05P1l0',
      reference: 'WHOqiwy05P1l0',
      chargeId: 'yCzJxeT2aXDqI',
      status: RefundStatus.Succeeded,
      providerStatus: 'SUCCESS',
      amount: 100000,
      createdAt: '2025-08-06T11:50:02.000Z',
    });
    // The refund webhook carries no subscription id.
    expect(event.subscriptionId).toBeUndefined();
  });

  it('SUBSCRIPTION_CARD_EXPIRY_REMINDER is verified but not normalised (Unknown), with the subscription id', () => {
    const event = parse(CARD_EXPIRY_2025);
    expect(event).toMatchObject({
      id: 'SUBSCRIPTION_CARD_EXPIRY_REMINDER:SUB_TEST_1754550382119:2025-09-24T02:00:09+05:30',
      type: EventType.Unknown,
      providerEventType: 'SUBSCRIPTION_CARD_EXPIRY_REMINDER',
      subscriptionId: 'SUB_TEST_1754550382119',
    });
  });

  it('the controlled-flow events are verified but not normalised (Unknown)', () => {
    const notification = parse(CONTROLLED_NOTIFICATION);
    expect(notification).toMatchObject({
      id: 'SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS:3333:SUCCESS:2025-06-01T22:15:59+05:30',
      type: EventType.Unknown,
      providerEventType: 'SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS',
      subscriptionId: 'test-subscription-id',
    });
    const execution = parse(CONTROLLED_EXECUTION);
    expect(execution).toMatchObject({
      id: 'SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS:3333:SUCCESS:2025-06-01T22:15:59+05:30',
      type: EventType.Unknown,
      subscriptionId: 'test-subscription-id',
    });
  });

  it('an event type not in the documented list is Unknown, keeps its name, and gets an id from the body hash', () => {
    const rawBody = JSON.stringify({ type: 'SUBSCRIPTION_SOMETHING_NEW', event_time: '2026-01-01T00:00:00+05:30', data: { a: 1 } });
    const event = parse(rawBody);
    const hash = createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
    expect(event).toMatchObject({
      id: `SUBSCRIPTION_SOMETHING_NEW:${hash}`,
      type: EventType.Unknown,
      providerEventType: 'SUBSCRIPTION_SOMETHING_NEW',
      occurredAt: '2025-12-31T18:30:00.000Z',
    });
  });

  it('keeps the whole verified body in raw', () => {
    const event = parse(PAYMENT_SUCCESS_2026);
    expect(event.raw).toEqual(JSON.parse(PAYMENT_SUCCESS_2026));
  });
});

describe('parseWebhook event ids (de-duplication)', () => {
  it('is stable across redeliveries, even with a different delivery timestamp', () => {
    const first = provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: signedHeaders(PAYMENT_SUCCESS_2026, CLIENT_SECRET, '1') });
    const second = provider().parseWebhook({ rawBody: PAYMENT_SUCCESS_2026, headers: signedHeaders(PAYMENT_SUCCESS_2026, CLIENT_SECRET, '2') });
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it('differs between transitions of the same entity', () => {
    const later = edit(STATUS_CHANGED_2025, (body) => {
      body.event_time = '2025-08-08T10:31:35+05:30';
    });
    const otherStatus = edit(STATUS_CHANGED_2025, (body) => {
      body.data.subscription_details.subscription_status = 'ACTIVE';
    });
    const ids = [STATUS_CHANGED_2025, later, otherStatus].map((rawBody) => parse(rawBody).id);
    expect(new Set(ids).size).toBe(3);
  });

  it('differs between retried attempts of one payment', () => {
    const retried = edit(PAYMENT_FAILED_2026, (body) => {
      body.data.retry_attempts = 1;
      body.event_time = '2025-08-07T11:24:45+05:30';
    });
    expect(parse(retried).id).not.toBe(parse(PAYMENT_FAILED_2026).id);
  });
});

// ---------------------------------------------------------------------------
// Status tables through the webhook path
// ---------------------------------------------------------------------------

describe('SUBSCRIPTION_STATUS_CHANGED status table', () => {
  it.each([
    ['INITIALIZED', SubscriptionStatus.Created, EventType.SubscriptionUpdated],
    ['BANK_APPROVAL_PENDING', SubscriptionStatus.PendingAuthorization, EventType.SubscriptionUpdated],
    ['ACTIVE', SubscriptionStatus.Active, EventType.SubscriptionActivated],
    ['ON_HOLD', SubscriptionStatus.Halted, EventType.SubscriptionHalted],
    ['PAUSED', SubscriptionStatus.Paused, EventType.SubscriptionPaused],
    ['CUSTOMER_PAUSED', SubscriptionStatus.Paused, EventType.SubscriptionPaused],
    ['COMPLETED', SubscriptionStatus.Completed, EventType.SubscriptionCompleted],
    ['CANCELLED', SubscriptionStatus.Cancelled, EventType.SubscriptionCancelled],
    ['CUSTOMER_CANCELLED', SubscriptionStatus.Cancelled, EventType.SubscriptionCancelled],
    ['EXPIRED', SubscriptionStatus.Expired, EventType.SubscriptionExpired],
    ['LINK_EXPIRED', SubscriptionStatus.Expired, EventType.SubscriptionExpired],
    ['CARD_EXPIRED', SubscriptionStatus.Expired, EventType.SubscriptionExpired],
    // Not documented: stays visible verbatim; the event is Unknown, the status the non-charging Created.
    ['SOMETHING_NEW', SubscriptionStatus.Created, EventType.Unknown],
  ])('%s', (cashfreeStatus, status, type) => {
    const rawBody = edit(STATUS_CHANGED_2025, (body) => {
      body.data.subscription_details.subscription_status = cashfreeStatus;
    });
    const event = parse(rawBody);
    expect(event.type).toBe(type);
    expect(event.subscription?.status).toBe(status);
    expect(event.subscription?.providerStatus).toBe(cashfreeStatus);
  });
});

describe('SUBSCRIPTION_AUTH_STATUS outcomes', () => {
  const success = (change: (body: any) => void = () => {}) =>
    edit(AUTH_STATUS_2026, (body) => {
      body.data.payment_status = 'SUCCESS';
      body.data.authorization_details.authorization_status = 'ACTIVE';
      change(body);
    });

  it.each([['ACTIVE'], ['SUCCESS']])('authorisation status %s on a live mandate is Authorized', (authorizationStatus) => {
    const rawBody = success((body) => {
      body.data.authorization_details.authorization_status = authorizationStatus;
    });
    expect(parse(rawBody).type).toBe(EventType.SubscriptionAuthorized);
  });

  it('is only Updated while the bank has not approved the mandate yet (a scheduler must not start charging)', () => {
    const rawBody = success((body) => {
      body.data.subscription_details.subscription_status = 'BANK_APPROVAL_PENDING';
    });
    expect(parse(rawBody).type).toBe(EventType.SubscriptionUpdated);
  });

  it('is Authorized when the payload carries no subscription_details (2025-01-01 shape)', () => {
    const rawBody = success((body) => {
      delete body.data.subscription_details;
    });
    expect(parse(rawBody).type).toBe(EventType.SubscriptionAuthorized);
  });

  it('falls back to the payment status when the authorisation status is missing', () => {
    const rawBody = success((body) => {
      body.data.authorization_details.authorization_status = null;
    });
    expect(parse(rawBody).type).toBe(EventType.SubscriptionAuthorized);
    const failed = edit(AUTH_STATUS_2026, (body) => {
      body.data.authorization_details.authorization_status = null;
    });
    expect(parse(failed).type).toBe(EventType.SubscriptionAuthorizationFailed);
  });

  it('is Updated while still pending', () => {
    const rawBody = edit(AUTH_STATUS_2026, (body) => {
      body.data.payment_status = 'PENDING';
      body.data.authorization_details.authorization_status = 'PENDING';
    });
    expect(parse(rawBody).type).toBe(EventType.SubscriptionUpdated);
  });
});

describe('payment webhook status table', () => {
  it.each([
    ['INITIALIZED', ChargeStatus.Scheduled],
    ['PENDING', ChargeStatus.Pending],
    ['SUCCESS', ChargeStatus.Succeeded],
    ['FAILED', ChargeStatus.Failed],
    ['CANCELLED', ChargeStatus.Cancelled],
    // Unknown: neither collected nor retryable until re-read.
    ['SOMETHING_NEW', ChargeStatus.Pending],
  ])('payment_status %s', (paymentStatus, chargeStatus) => {
    const rawBody = edit(PAYMENT_SUCCESS_2026, (body) => {
      body.data.payment_status = paymentStatus;
    });
    const event = parse(rawBody);
    expect(event.charge?.status).toBe(chargeStatus);
    expect(event.charge?.providerStatus).toBe(paymentStatus);
    // Only a succeeded payment has a paidAt.
    expect(event.charge?.paidAt !== undefined).toBe(chargeStatus === ChargeStatus.Succeeded);
  });
});

describe('refund webhook status table', () => {
  it.each([
    ['SUCCESS', EventType.RefundSucceeded, RefundStatus.Succeeded],
    ['FAILED', EventType.RefundFailed, RefundStatus.Failed],
    ['CANCELLED', EventType.RefundFailed, RefundStatus.Failed],
    ['CANCEL', EventType.RefundFailed, RefundStatus.Failed],
    ['PENDING', EventType.Unknown, RefundStatus.Pending],
    ['INITIALIZED', EventType.Unknown, RefundStatus.Pending],
  ])('refund_status %s', (refundStatus, type, status) => {
    const rawBody = edit(REFUND_STATUS_2025, (body) => {
      body.data.refund_status = refundStatus;
    });
    const event = parse(rawBody);
    expect(event.type).toBe(type);
    expect(event.refund?.status).toBe(status);
  });
});
