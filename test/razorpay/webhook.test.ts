import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChargeStatus, ErrorCode, EventType, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { SubscriptionEventSchema, type WebhookRequest } from '../../src/schemas.js';
import { RazorpayHeader, RazorpayWebhookEvent } from '../../src/providers/razorpay/constants.js';
import { WEBHOOK_EVENT_MAP } from '../../src/providers/razorpay/mapper.js';
import { razorpay } from '../../src/providers/razorpay/index.js';
import { mockFetch } from '../helpers/mock-fetch.js';

/*
 * Webhook tests. Every subscription event is exercised from its verbatim
 * sample payload in the Razorpay docs (webhooks__subscriptions.md). The
 * signature is computed here with node:crypto, independently of the adapter,
 * following webhooks__validate-test.md: hex(HMAC_SHA256(secret, raw body)).
 */

const KEY_ID = 'test_key_id';
const KEY_SECRET = 'test_key_secret_value';
const WEBHOOK_SECRET = 'test_webhook_secret_value';

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const sign = (body: string, secret = WEBHOOK_SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');

function provider(webhookSecret: string | undefined | 'none' = WEBHOOK_SECRET) {
  const secret = webhookSecret === 'none' ? undefined : webhookSecret;
  return razorpay({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: secret }, { fetch: mockFetch([]).fetch });
}

function signed(body: string, eventId?: string): WebhookRequest {
  return {
    rawBody: body,
    headers: {
      [RazorpayHeader.Signature]: sign(body),
      ...(eventId === undefined ? {} : { [RazorpayHeader.EventId]: eventId }),
    },
  };
}

function thrown(run: () => unknown): SubscriptionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the call to throw');
}

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.authenticated. */
const WEBHOOK_AUTHENTICATED = String.raw`{
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

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.activated (future start date and no upfront amount). */
const WEBHOOK_ACTIVATED_FUTURE = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "subscription.activated",
  "contains": [
    "subscription"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_DEX6xcJ1HSW4CR",
        "entity": "subscription",
        "plan_id": "plan_BvrFKjSxauOH7N",
        "customer_id": "cust_C0WlbKhp3aLA7W",
        "status": "active",
        "current_start": 1570213800,
        "current_end": 1572892200,
        "ended_at": null,
        "quantity": 1,
        "notes": {
          "notes_key_1": "Tea, Earl Grey, Hot",
          "notes_key_2": "Tea, Earl Grey… decaf."
        },
        "charge_at": 1570213800,
        "start_at": 1570213800,
        "end_at": 1599244200,
        "auth_attempts": 0,
        "total_count": 12,
        "paid_count": 0,
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
    }
  },
  "created_at": 1567690383
}`;

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.activated (immediate start date/upfront amount/both). */
const WEBHOOK_ACTIVATED_IMMEDIATE = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "subscription.activated",
  "contains": [
    "subscription"
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
          "notes_key_1": "Tea, Earl Grey, Hot",
          "notes_key_2": "Tea, Earl Grey… decaf."
        },
        "charge_at": 1570213800,
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
    },
    "created_at": 1567690383
  }
}`;

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.charged. */
const WEBHOOK_CHARGED = String.raw`{
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

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.completed. */
const WEBHOOK_COMPLETED = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "subscription.completed",
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
        "status": "completed",
        "type": 2,
        "current_start": 1599244200,
        "current_end": 1601836200,
        "ended_at": 1599244200,
        "quantity": 1,
        "notes": {
          "Important": "Notes for Internal Reference"
        },
        "charge_at": null,
        "start_at": 1570213800,
        "end_at": 1599244200,
        "auth_attempts": 0,
        "total_count": 12,
        "paid_count": 11,
        "customer_notify": true,
        "created_at": 1567689895,
        "expire_by": 1567881000,
        "short_url": null,
        "has_scheduled_changes": false,
        "change_scheduled_at": null,
        "source": "api",
        "offer_id":"offer_JHD834hjbxzhd38d",
        "remaining_count": 0
      }
    },
    "payment": {
      "entity": {
        "id": "pay_DEXkZ54GsNwVk9",
        "entity": "payment",
        "amount": 100000,
        "currency": "INR",
        "status": "captured",
        "order_id": "order_DEXkYoCpua7kn3",
        "invoice_id": "inv_DEXkYmFDy966lT",
        "international": false,
        "method": "card",
        "amount_refunded": 0,
        "amount_transferred": 0,
        "refund_status": null,
        "captured": "1",
        "description": "Recurring Payment via Subscription",
        "card_id": "card_DEXkZBosDfKGEe",
        "card": {
          "id": "card_DEXkZBosDfKGEe",
          "entity": "card",
          "name": "Gaurav Kumar",
          "last4": "0008",
          "network": "MasterCard",
          "type": "unknown",
          "issuer": "",
          "international": false,
          "emi": false,
          "expiry_month": 11,
          "expiry_year": 2031
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
        "created_at": 1567692144
      }
    }
  },
  "created_at": 1567692150
}`;

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.updated. */
const WEBHOOK_UPDATED = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "subscription.updated",
  "contains": [
    "subscription"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_DEXpmJhEIZK4fe",
        "entity": "subscription",
        "plan_id": "plan_BvrHngQ0xLNnNG",
        "customer_id": "cust_C0WlbKhp3aLA7W",
        "status": "active",
        "type": 3,
        "current_start": 1567692455,
        "current_end": 1570213800,
        "ended_at": null,
        "quantity": 4,
        "notes": {
          "Important": "Notes for Internal Reference"
        },
        "charge_at": 1570213800,
        "start_at": 1567692455,
        "end_at": 1599071400,
        "auth_attempts": 0,
        "total_count": 53,
        "paid_count": 1,
        "customer_notify": true,
        "created_at": 1567692440,
        "expire_by": 1567881000,
        "short_url": null,
        "has_scheduled_changes": false,
        "change_scheduled_at": null,
        "source": "api",
        "offer_id":"offer_JHD834hjbxzhd38d",
        "remaining_count": 52
      }
    }
  },
  "created_at": 1567692560
}`;

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.pending. */
const WEBHOOK_PENDING = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "subscription.pending",
  "contains": [
    "subscription"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_DEX6xcJ1HSW4CR",
        "entity": "subscription",
        "plan_id": "plan_BvrFKjSxauOH7N",
        "customer_id": "cust_C0WlbKhp3aLA7W",
        "status": "pending",
        "type": 2,
        "current_start": 1572892200,
        "current_end": 1575484200,
        "ended_at": null,
        "quantity": 1,
        "notes": {
          "Important": "Notes for Internal Reference"
        },
        "charge_at": 1572978600,
        "start_at": 1570213800,
        "end_at": 1599244200,
        "auth_attempts": 1,
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
        "remaining_count": 10
      }
    }
  },
  "created_at": 1567691026
}`;

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.halted. */
const WEBHOOK_HALTED = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "subscription.halted",
  "contains": [
    "subscription"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_DEX6xcJ1HSW4CR",
        "entity": "subscription",
        "plan_id": "plan_BvrFKjSxauOH7N",
        "customer_id": "cust_C0WlbKhp3aLA7W",
        "status": "halted",
        "type": 2,
        "current_start": 1572892200,
        "current_end": 1575484200,
        "ended_at": null,
        "quantity": 1,
        "notes": {
          "Important": "Notes for Internal Reference"
        },
        "charge_at": 1575484200,
        "start_at": 1570213800,
        "end_at": 1599244200,
        "auth_attempts": 4,
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
        "remaining_count": 10
      }
    }
  },
  "created_at": 1567691269
}`;

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.paused. */
const WEBHOOK_PAUSED = String.raw`{
  "entity": "event",
  "account_id": "acc_Fe3fPCmiStazv3",
  "event": "subscription.paused",
  "contains": [
    "subscription"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_FeQ9WWOjGUZMpG",
        "entity": "subscription",
        "plan_id": "plan_FeMmuaVVa1HR0W",
        "customer_id": "cust_FeOEa4PPa0by07",
        "status": "paused",
        "type": 1,
        "current_start": 1600416437,
        "current_end": 1602959400,
        "ended_at": null,
        "quantity": 1,
        "notes": [],
        "charge_at": null,
        "start_at": 1600416437,
        "end_at": 1610908200,
        "auth_attempts": 0,
        "total_count": 5,
        "paid_count": 1,
        "customer_notify": true,
        "created_at": 1600416405,
        "expire_by": null,
        "short_url": null,
        "has_scheduled_changes": false,
        "change_scheduled_at": null,
        "source": "api",
        "offer_id":"offer_JHD834hjbxzhd38d",
        "payment_method": "card",
        "remaining_count": 4,
        "pause_initiated_by": "self",
        "cancel_initiated_by": null
      }
    }
  },
  "created_at": 1600416473
}`;

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.resumed. */
const WEBHOOK_RESUMED = String.raw`{
  "entity": "event",
  "account_id": "acc_Fe3fPCmiStazv3",
  "event": "subscription.resumed",
  "contains": [
    "subscription"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_FeQ9WWOjGUZMpG",
        "entity": "subscription",
        "plan_id": "plan_FeMmuaVVa1HR0W",
        "customer_id": "cust_FeOEa4PPa0by07",
        "status": "active",
        "type": 1,
        "current_start": 1600416437,
        "current_end": 1602959400,
        "ended_at": null,
        "quantity": 1,
        "notes": [],
        "charge_at": 1602959400,
        "start_at": 1600416437,
        "end_at": 1610908200,
        "auth_attempts": 0,
        "total_count": 5,
        "paid_count": 1,
        "customer_notify": true,
        "created_at": 1600416405,
        "expire_by": null,
        "short_url": null,
        "has_scheduled_changes": false,
        "change_scheduled_at": null,
        "source": "api",
        "offer_id":"offer_JHD834hjbxzhd38d",
        "payment_method": "card",
        "remaining_count": 4,
        "pause_initiated_by": null,
        "cancel_initiated_by": null
      }
    }
  },
  "created_at": 1600416481
}`;

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.cancelled. */
const WEBHOOK_CANCELLED = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "subscription.cancelled",
  "contains": [
    "subscription"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_DEXpmJhEIZK4fe",
        "entity": "subscription",
        "plan_id": "plan_BvrHngQ0xLNnNG",
        "customer_id": "cust_C0WlbKhp3aLA7W",
        "status": "cancelled",
        "type": 3,
        "current_start": 1568226600,
        "current_end": 1568831400,
        "ended_at": 1567692729,
        "quantity": 4,
        "notes": {
          "Important": "Notes for Internal Reference"
        },
        "charge_at": null,
        "start_at": 1567692455,
        "end_at": 1599071400,
        "auth_attempts": 0,
        "total_count": 53,
        "paid_count": 2,
        "customer_notify": true,
        "created_at": 1567692440,
        "expire_by": 1567881000,
        "short_url": null,
        "has_scheduled_changes": false,
        "change_scheduled_at": null,
        "source": "api",
        "offer_id":"offer_JHD834hjbxzhd38d",
        "remaining_count": 51
      }
    }
  },
  "created_at": 1567692732
}`;


interface Case {
  name: string;
  body: string;
  event: RazorpayWebhookEvent;
  type: EventType;
  status: SubscriptionStatus;
  subscriptionId: string;
  occurredAt: number;
  paymentId?: string;
}

const cases: Case[] = [
  {
    name: 'authenticated',
    body: WEBHOOK_AUTHENTICATED,
    event: RazorpayWebhookEvent.Authenticated,
    type: EventType.SubscriptionAuthorized,
    status: SubscriptionStatus.Trialing,
    subscriptionId: 'sub_F5aa7VaVXtXh80',
    occurredAt: 1592811255,
  },
  {
    name: 'activated (future start, no upfront)',
    body: WEBHOOK_ACTIVATED_FUTURE,
    event: RazorpayWebhookEvent.Activated,
    type: EventType.SubscriptionActivated,
    status: SubscriptionStatus.Active,
    subscriptionId: 'sub_DEX6xcJ1HSW4CR',
    occurredAt: 1567690383,
  },
  {
    // created_at sits inside payload in this sample and `contains` omits payment although it is present.
    name: 'activated (immediate start / upfront)',
    body: WEBHOOK_ACTIVATED_IMMEDIATE,
    event: RazorpayWebhookEvent.Activated,
    type: EventType.SubscriptionActivated,
    status: SubscriptionStatus.Active,
    subscriptionId: 'sub_DEX6xcJ1HSW4CR',
    occurredAt: 1567690383,
    paymentId: 'pay_DEXFWroJ6LikKT',
  },
  {
    name: 'charged',
    body: WEBHOOK_CHARGED,
    event: RazorpayWebhookEvent.Charged,
    type: EventType.SubscriptionCharged,
    status: SubscriptionStatus.Active,
    subscriptionId: 'sub_DEX6xcJ1HSW4CR',
    occurredAt: 1567690383,
    paymentId: 'pay_DEXFWroJ6LikKT',
  },
  {
    name: 'completed',
    body: WEBHOOK_COMPLETED,
    event: RazorpayWebhookEvent.Completed,
    type: EventType.SubscriptionCompleted,
    status: SubscriptionStatus.Completed,
    subscriptionId: 'sub_DEX6xcJ1HSW4CR',
    occurredAt: 1567692150,
    paymentId: 'pay_DEXkZ54GsNwVk9',
  },
  {
    name: 'updated',
    body: WEBHOOK_UPDATED,
    event: RazorpayWebhookEvent.Updated,
    type: EventType.SubscriptionUpdated,
    status: SubscriptionStatus.Active,
    subscriptionId: 'sub_DEXpmJhEIZK4fe',
    occurredAt: 1567692560,
  },
  {
    name: 'pending',
    body: WEBHOOK_PENDING,
    event: RazorpayWebhookEvent.Pending,
    type: EventType.SubscriptionPastDue,
    status: SubscriptionStatus.PastDue,
    subscriptionId: 'sub_DEX6xcJ1HSW4CR',
    occurredAt: 1567691026,
  },
  {
    name: 'halted',
    body: WEBHOOK_HALTED,
    event: RazorpayWebhookEvent.Halted,
    type: EventType.SubscriptionHalted,
    status: SubscriptionStatus.Halted,
    subscriptionId: 'sub_DEX6xcJ1HSW4CR',
    occurredAt: 1567691269,
  },
  {
    name: 'paused',
    body: WEBHOOK_PAUSED,
    event: RazorpayWebhookEvent.Paused,
    type: EventType.SubscriptionPaused,
    status: SubscriptionStatus.Paused,
    subscriptionId: 'sub_FeQ9WWOjGUZMpG',
    occurredAt: 1600416473,
  },
  {
    // The docs describe the status as "resumed"; the payload carries active.
    name: 'resumed',
    body: WEBHOOK_RESUMED,
    event: RazorpayWebhookEvent.Resumed,
    type: EventType.SubscriptionResumed,
    status: SubscriptionStatus.Active,
    subscriptionId: 'sub_FeQ9WWOjGUZMpG',
    occurredAt: 1600416481,
  },
  {
    name: 'cancelled',
    body: WEBHOOK_CANCELLED,
    event: RazorpayWebhookEvent.Cancelled,
    type: EventType.SubscriptionCancelled,
    status: SubscriptionStatus.Cancelled,
    subscriptionId: 'sub_DEXpmJhEIZK4fe',
    occurredAt: 1567692732,
  },
];

describe('parseWebhook: every documented subscription event', () => {
  it('covers every event constant exactly once in the mapping table', () => {
    expect(Object.keys(WEBHOOK_EVENT_MAP).sort()).toEqual(Object.values(RazorpayWebhookEvent).sort());
    const covered = new Set(cases.map((c) => c.event));
    expect([...covered].sort()).toEqual(Object.values(RazorpayWebhookEvent).sort());
  });

  it.each(cases)('normalises $name', ({ body, event, type, status, subscriptionId, occurredAt, paymentId }) => {
    const events = provider().parseWebhook(signed(body, 'evt_header_1'));
    expect(events).toHaveLength(1);
    const [normalised] = events;
    expect(normalised).toMatchObject({
      id: 'evt_header_1',
      provider: 'razorpay',
      type,
      providerEventType: event,
      occurredAt: iso(occurredAt),
      subscriptionId,
    });
    expect(normalised?.subscription).toMatchObject({ id: subscriptionId, status, scheduling: 'gateway' });
    expect(normalised?.raw).toEqual(JSON.parse(body));
    if (paymentId) {
      expect(normalised?.charge).toMatchObject({ id: paymentId, subscriptionId, status: ChargeStatus.Succeeded, amount: 100000, currency: 'INR' });
    } else {
      expect(normalised?.charge).toBeUndefined();
    }
    expect(SubscriptionEventSchema.safeParse(normalised).success).toBe(true);
  });

  it('maps the payment entity of subscription.charged to a charge with the invoice as reference', () => {
    const [event] = provider().parseWebhook(signed(WEBHOOK_CHARGED, 'e'));
    expect(event?.charge).toMatchObject({
      id: 'pay_DEXFWroJ6LikKT',
      reference: 'inv_DEXFWVuM6rPqlK',
      kind: 'recurring',
      providerStatus: 'captured',
      paymentMethod: 'card',
      refundedAmount: 0,
    });
    expect(event?.subscription).toMatchObject({ paidCycles: 1, totalCycles: 12, remainingCycles: 11, quantity: 1 });
  });

  it('carries trialEndsAt for an authenticated subscription', () => {
    const [event] = provider().parseWebhook(signed(WEBHOOK_AUTHENTICATED, 'e'));
    expect(event?.subscription?.trialEndsAt).toBe(iso(1593109800));
  });

  it('reads the pause and cancel details from their samples', () => {
    const [paused] = provider().parseWebhook(signed(WEBHOOK_PAUSED, 'e'));
    expect(paused?.subscription).toMatchObject({ paymentMethod: 'card', nextChargeAt: undefined });
    const [cancelled] = provider().parseWebhook(signed(WEBHOOK_CANCELLED, 'e'));
    expect(cancelled?.subscription).toMatchObject({ endedAt: iso(1567692729), paidCycles: 2 });
  });
});

describe('parseWebhook: event id', () => {
  it('uses the x-razorpay-event-id header, matched case-insensitively', () => {
    const request: WebhookRequest = {
      rawBody: WEBHOOK_PENDING,
      headers: { 'X-Razorpay-Signature': sign(WEBHOOK_PENDING), 'X-Razorpay-Event-Id': 'evt_Upper' },
    };
    expect(provider().parseWebhook(request)[0]?.id).toBe('evt_Upper');
  });

  it('falls back to event name + subscription id + timestamp, which is stable across redeliveries', () => {
    const first = provider().parseWebhook(signed(WEBHOOK_PENDING))[0];
    const again = provider().parseWebhook(signed(WEBHOOK_PENDING))[0];
    expect(first?.id).toBe('subscription.pending:sub_DEX6xcJ1HSW4CR:1567691026');
    expect(again?.id).toBe(first?.id);
  });

  it('uses the payload timestamp for the sample that nests created_at inside payload', () => {
    const event = provider().parseWebhook(signed(WEBHOOK_ACTIVATED_IMMEDIATE))[0];
    expect(event?.id).toBe('subscription.activated:sub_DEX6xcJ1HSW4CR:1567690383');
  });

  it('accepts an array-valued header', () => {
    const request: WebhookRequest = {
      rawBody: WEBHOOK_HALTED,
      headers: { [RazorpayHeader.Signature]: [sign(WEBHOOK_HALTED)], [RazorpayHeader.EventId]: ['evt_arr'] },
    };
    expect(provider().parseWebhook(request)[0]?.id).toBe('evt_arr');
  });
});

describe('parseWebhook: events this adapter does not normalise', () => {
  // Constructed bodies: the subscription docs do not document refund or payment events, so there is no sample to copy.
  const paymentCaptured = JSON.stringify({
    entity: 'event',
    account_id: 'acc_BFQ7uQEaa7j2z7',
    event: 'payment.captured',
    contains: ['payment'],
    payload: { payment: { entity: { id: 'pay_1', entity: 'payment', amount: 100, status: 'captured' } } },
    created_at: 1600000000,
  });
  const refundProcessed = JSON.stringify({
    entity: 'event',
    event: 'refund.processed',
    contains: ['refund'],
    payload: { refund: { entity: { id: 'rfnd_1', entity: 'refund', amount: 100, payment_id: 'pay_1', status: 'processed' } } },
    created_at: 1600000001,
  });

  it.each([
    ['payment.captured', paymentCaptured],
    ['refund.processed', refundProcessed],
  ])('returns %s as unknown with the raw body and the verbatim event name', (name, body) => {
    const [event] = provider().parseWebhook(signed(body, 'evt_x'));
    expect(event).toMatchObject({ id: 'evt_x', type: EventType.Unknown, providerEventType: name });
    expect(event?.subscription).toBeUndefined();
    expect(event?.charge).toBeUndefined();
    expect(event?.raw).toEqual(JSON.parse(body));
    expect(SubscriptionEventSchema.safeParse(event).success).toBe(true);
  });

  it('does not fail an unknown event whose entities have a shape this adapter has never seen', () => {
    const body = JSON.stringify({ event: 'subscription.something_new', payload: { subscription: { entity: 'surprise' } }, created_at: 1600000002 });
    expect(provider().parseWebhook(signed(body))[0]).toMatchObject({
      type: EventType.Unknown,
      providerEventType: 'subscription.something_new',
      id: 'subscription.something_new::1600000002',
    });
  });
});

describe('parseWebhook: signature', () => {
  it('rejects a wrong signature with SIGNATURE_INVALID', () => {
    const error = thrown(() => provider().parseWebhook({ rawBody: WEBHOOK_CHARGED, headers: { [RazorpayHeader.Signature]: 'deadbeef' } }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect(error.provider).toBe('razorpay');
  });

  it('rejects a missing signature header', () => {
    expect(thrown(() => provider().parseWebhook({ rawBody: WEBHOOK_CHARGED, headers: {} })).code).toBe(ErrorCode.SignatureInvalid);
    expect(thrown(() => provider().parseWebhook({ rawBody: WEBHOOK_CHARGED, headers: { [RazorpayHeader.Signature]: '' } })).code).toBe(
      ErrorCode.SignatureInvalid,
    );
    expect(thrown(() => provider().parseWebhook({ rawBody: WEBHOOK_CHARGED, headers: { [RazorpayHeader.Signature]: undefined } })).code).toBe(
      ErrorCode.SignatureInvalid,
    );
  });

  it('rejects a body changed after signing, by a single character', () => {
    const tampered = WEBHOOK_CHARGED.replace('"paid_count": 1', '"paid_count": 2');
    expect(tampered).not.toBe(WEBHOOK_CHARGED);
    const request: WebhookRequest = { rawBody: tampered, headers: { [RazorpayHeader.Signature]: sign(WEBHOOK_CHARGED) } };
    expect(thrown(() => provider().parseWebhook(request)).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('verifies the raw bytes: a re-serialised body does not verify', () => {
    const reserialised = JSON.stringify(JSON.parse(WEBHOOK_CHARGED));
    const request: WebhookRequest = { rawBody: reserialised, headers: { [RazorpayHeader.Signature]: sign(WEBHOOK_CHARGED) } };
    expect(thrown(() => provider().parseWebhook(request)).code).toBe(ErrorCode.SignatureInvalid);
    // A trailing newline is a different message too.
    const newline: WebhookRequest = { rawBody: `${WEBHOOK_CHARGED}\n`, headers: { [RazorpayHeader.Signature]: sign(WEBHOOK_CHARGED) } };
    expect(thrown(() => provider().parseWebhook(newline)).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('rejects a signature made with another secret, with the API key secret, or in upper case', () => {
    for (const signature of [sign(WEBHOOK_CHARGED, 'another-secret'), sign(WEBHOOK_CHARGED, KEY_SECRET), sign(WEBHOOK_CHARGED).toUpperCase()]) {
      const request: WebhookRequest = { rawBody: WEBHOOK_CHARGED, headers: { [RazorpayHeader.Signature]: signature } };
      expect(thrown(() => provider().parseWebhook(request)).code).toBe(ErrorCode.SignatureInvalid);
    }
  });

  it('verifies a body with non-ASCII characters (the samples contain "…")', () => {
    expect(WEBHOOK_ACTIVATED_FUTURE).toContain('…');
    expect(provider().parseWebhook(signed(WEBHOOK_ACTIVATED_FUTURE))).toHaveLength(1);
  });

  it('is CONFIG when no webhookSecret was configured, even for a request that carries a signature', () => {
    const error = thrown(() => provider('none').parseWebhook(signed(WEBHOOK_CHARGED)));
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain('webhookSecret');
  });

  it('parses nothing from a body whose signature fails: an invalid body is reported as a signature failure first', () => {
    const request: WebhookRequest = { rawBody: 'not json at all', headers: { [RazorpayHeader.Signature]: 'bad' } };
    expect(thrown(() => provider().parseWebhook(request)).code).toBe(ErrorCode.SignatureInvalid);
  });
});

describe('parseWebhook: verified but malformed bodies', () => {
  it('is UNEXPECTED_RESPONSE for a correctly signed body that is not JSON', () => {
    expect(thrown(() => provider().parseWebhook(signed('not json at all'))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('is UNEXPECTED_RESPONSE when the envelope lacks an event name or payload', () => {
    expect(thrown(() => provider().parseWebhook(signed(JSON.stringify({ payload: {} })))).code).toBe(ErrorCode.UnexpectedResponse);
    expect(thrown(() => provider().parseWebhook(signed(JSON.stringify({ event: 'subscription.charged' })))).code).toBe(
      ErrorCode.UnexpectedResponse,
    );
  });

  it('is UNEXPECTED_RESPONSE when a subscription event has no subscription entity, or a payment that is not valid', () => {
    const noSubscription = JSON.stringify({ event: 'subscription.charged', payload: {}, created_at: 1 });
    expect(thrown(() => provider().parseWebhook(signed(noSubscription))).code).toBe(ErrorCode.UnexpectedResponse);
    const base = JSON.parse(WEBHOOK_CHARGED);
    base.payload.payment.entity.amount = '100000';
    expect(thrown(() => provider().parseWebhook(signed(JSON.stringify(base)))).code).toBe(ErrorCode.UnexpectedResponse);
    base.payload.payment.entity.amount = 1000.5;
    expect(thrown(() => provider().parseWebhook(signed(JSON.stringify(base)))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('keeps an unknown subscription status verbatim', () => {
    const base = JSON.parse(WEBHOOK_PENDING);
    base.payload.subscription.entity.status = 'under_review';
    const [event] = provider().parseWebhook(signed(JSON.stringify(base)));
    expect(event?.subscription).toMatchObject({ status: SubscriptionStatus.Created, providerStatus: 'under_review' });
    expect(event?.type).toBe(EventType.SubscriptionPastDue);
  });
});

describe('parseWebhook: secrets stay out of errors', () => {
  it('never puts a secret or an expected signature in any thrown error', () => {
    const errors = [
      thrown(() => provider().parseWebhook({ rawBody: WEBHOOK_CHARGED, headers: {} })),
      thrown(() => provider().parseWebhook({ rawBody: WEBHOOK_CHARGED, headers: { [RazorpayHeader.Signature]: 'deadbeef' } })),
      thrown(() => provider('none').parseWebhook(signed(WEBHOOK_CHARGED))),
      thrown(() => provider().parseWebhook(signed('not json'))),
    ];
    for (const error of errors) {
      const everything = JSON.stringify({ message: error.message, json: error.toJSON(), raw: error.raw, stack: error.stack });
      expect(everything).not.toContain(WEBHOOK_SECRET);
      expect(everything).not.toContain(KEY_SECRET);
      expect(everything).not.toContain(sign(WEBHOOK_CHARGED));
    }
  });
});
