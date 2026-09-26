/**
 * The JSON bodies `india-subscriptions serve` POSTs to `EVENTS_WEBHOOK_URL`, as Zod schemas (published in the
 * OpenAPI document under the component names in `ServerSchemaName`). Two kinds of delivery share one URL and one
 * signature scheme; the `kind` field tells them apart:
 *
 * - `gateway`: the verified, normalised events of one gateway webhook (`SubscriptionEvent`, which carries its own `id`).
 * - `scheduler`: events of the billing scheduler. For merchant-scheduled gateways (PayU, Cashfree on-demand) this
 *   is how your application learns about debits, because those gateways' own webhooks do not carry enough to
 *   attribute a debit. Each carries an `id` derived from its content, so a repeat is recognisable.
 */
import { z } from 'zod';
import { HashAlgorithm } from './constants.js';
import { hash } from './crypto.js';
import { ProviderSchema, SubscriptionEventSchema } from './schemas.js';
import { SchedulerEventSchema, type SchedulerEvent } from './scheduler/schemas.js';

/** Value of the `kind` field of a delivery. */
export const EventsDeliveryKind = {
  /** Events from a gateway's webhook. */
  Gateway: 'gateway',
  /** Events from the billing scheduler. */
  Scheduler: 'scheduler',
} as const;
export type EventsDeliveryKind = (typeof EventsDeliveryKind)[keyof typeof EventsDeliveryKind];

export const SCHEDULER_EVENT_ID_PREFIX = 'sevt';
const ID_SEPARATOR = '_';
const SCHEDULER_EVENT_ID_HEX_LENGTH = 32;

export const GatewayEventsDeliverySchema = z
  .object({
    kind: z.literal(EventsDeliveryKind.Gateway).describe('Always `gateway`: tells this delivery from a scheduler one.'),
    provider: ProviderSchema.describe('The gateway whose webhook carried the events.'),
    events: z
      .array(SubscriptionEventSchema)
      .min(1)
      .describe('The verified, normalised events of one gateway webhook, in the order the gateway sent them. Each has an `id` to de-duplicate on.'),
  })
  .describe('A delivery of gateway webhook events to the events webhook.');
export type GatewayEventsDelivery = z.infer<typeof GatewayEventsDeliverySchema>;

/** A scheduler event as delivered: the event plus a stable id. */
export const SchedulerWebhookEventSchema = SchedulerEventSchema.extend({
  id: z
    .string()
    .min(1)
    .describe(
      'Stable id for de-duplication: the same scheduler event always has the same id, so a repeated delivery can be ignored.',
    ),
}).describe('A state change of a billing schedule, with a stable id.');
export type SchedulerWebhookEvent = z.infer<typeof SchedulerWebhookEventSchema>;

export const SchedulerEventsDeliverySchema = z
  .object({
    kind: z.literal(EventsDeliveryKind.Scheduler).describe('Always `scheduler`: tells this delivery from a gateway one.'),
    events: z
      .array(SchedulerWebhookEventSchema)
      .min(1)
      .describe('Billing scheduler events in the order they happened. Each has an `id` to de-duplicate on.'),
  })
  .describe('A delivery of billing scheduler events to the events webhook.');
export type SchedulerEventsDelivery = z.infer<typeof SchedulerEventsDeliverySchema>;

export const EventsDeliverySchema = z
  .discriminatedUnion('kind', [GatewayEventsDeliverySchema, SchedulerEventsDeliverySchema])
  .describe('Anything the service POSTs to the events webhook; switch on `kind`.');
export type EventsDelivery = z.infer<typeof EventsDeliverySchema>;

/** JSON with object keys sorted at every depth, so equal events always serialise to the same text. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The id of a scheduler event: `sevt_` and 32 hex characters of the SHA-256 of its content. The scheduler may emit
 * the same change twice (after a crash between saving and emitting), and both copies get the same id.
 */
export function schedulerEventId(event: SchedulerEvent): string {
  return `${SCHEDULER_EVENT_ID_PREFIX}${ID_SEPARATOR}${hash(HashAlgorithm.Sha256, stableStringify(event)).slice(0, SCHEDULER_EVENT_ID_HEX_LENGTH)}`;
}

export function toSchedulerWebhookEvent(event: SchedulerEvent): SchedulerWebhookEvent {
  return { id: schedulerEventId(event), ...event };
}
