import { z } from 'zod';
import * as s from './schemas.js';

/**
 * Names under which the unified schemas are published to other languages
 * (JSON Schema `$defs` / OpenAPI `components.schemas`). Generated clients use
 * these as class names, so renaming one is a breaking change.
 */
export const SchemaName = {
  Provider: 'Provider',
  Currency: 'Currency',
  SubscriptionStatus: 'SubscriptionStatus',
  ChargeStatus: 'ChargeStatus',
  ChargeKind: 'ChargeKind',
  RefundStatus: 'RefundStatus',
  PaymentMethod: 'PaymentMethod',
  SchedulingMode: 'SchedulingMode',
  EventType: 'EventType',
  Environment: 'Environment',
  BillingInterval: 'BillingInterval',
  Customer: 'Customer',
  CreatePlanInput: 'CreatePlanInput',
  Plan: 'Plan',
  CheckoutInstruction: 'CheckoutInstruction',
  Trial: 'Trial',
  CreateSubscriptionInput: 'CreateSubscriptionInput',
  Subscription: 'Subscription',
  CancelSubscriptionOptions: 'CancelSubscriptionOptions',
  PauseSubscriptionOptions: 'PauseSubscriptionOptions',
  ResumeSubscriptionOptions: 'ResumeSubscriptionOptions',
  UpdateSubscriptionInput: 'UpdateSubscriptionInput',
  Charge: 'Charge',
  CreateChargeInput: 'CreateChargeInput',
  NotifyChargeInput: 'NotifyChargeInput',
  ChargeNotification: 'ChargeNotification',
  ListChargesOptions: 'ListChargesOptions',
  RefundInput: 'RefundInput',
  Refund: 'Refund',
  CheckoutResult: 'CheckoutResult',
  CheckoutVerification: 'CheckoutVerification',
  WebhookRequest: 'WebhookRequest',
  SubscriptionEvent: 'SubscriptionEvent',
  Capabilities: 'Capabilities',
} as const;
export type SchemaName = (typeof SchemaName)[keyof typeof SchemaName];

/** Every schema that is part of the public, cross-language contract. */
export const schemaRegistry = z.registry<{ id: string }>();

const NAMED: Record<SchemaName, z.ZodType> = {
  [SchemaName.Provider]: s.ProviderSchema,
  [SchemaName.Currency]: s.CurrencySchema,
  [SchemaName.SubscriptionStatus]: s.SubscriptionStatusSchema,
  [SchemaName.ChargeStatus]: s.ChargeStatusSchema,
  [SchemaName.ChargeKind]: s.ChargeKindSchema,
  [SchemaName.RefundStatus]: s.RefundStatusSchema,
  [SchemaName.PaymentMethod]: s.PaymentMethodSchema,
  [SchemaName.SchedulingMode]: s.SchedulingModeSchema,
  [SchemaName.EventType]: s.EventTypeSchema,
  [SchemaName.Environment]: s.EnvironmentSchema,
  [SchemaName.BillingInterval]: s.BillingIntervalSchema,
  [SchemaName.Customer]: s.CustomerSchema,
  [SchemaName.CreatePlanInput]: s.CreatePlanInputSchema,
  [SchemaName.Plan]: s.PlanSchema,
  [SchemaName.CheckoutInstruction]: s.CheckoutInstructionSchema,
  [SchemaName.Trial]: s.TrialSchema,
  [SchemaName.CreateSubscriptionInput]: s.CreateSubscriptionInputSchema,
  [SchemaName.Subscription]: s.SubscriptionSchema,
  [SchemaName.CancelSubscriptionOptions]: s.CancelSubscriptionOptionsSchema,
  [SchemaName.PauseSubscriptionOptions]: s.PauseSubscriptionOptionsSchema,
  [SchemaName.ResumeSubscriptionOptions]: s.ResumeSubscriptionOptionsSchema,
  [SchemaName.UpdateSubscriptionInput]: s.UpdateSubscriptionInputSchema,
  [SchemaName.Charge]: s.ChargeSchema,
  [SchemaName.CreateChargeInput]: s.CreateChargeInputSchema,
  [SchemaName.NotifyChargeInput]: s.NotifyChargeInputSchema,
  [SchemaName.ChargeNotification]: s.ChargeNotificationSchema,
  [SchemaName.ListChargesOptions]: s.ListChargesOptionsSchema,
  [SchemaName.RefundInput]: s.RefundInputSchema,
  [SchemaName.Refund]: s.RefundSchema,
  [SchemaName.CheckoutResult]: s.CheckoutResultSchema,
  [SchemaName.CheckoutVerification]: s.CheckoutVerificationSchema,
  [SchemaName.WebhookRequest]: s.WebhookRequestSchema,
  [SchemaName.SubscriptionEvent]: s.SubscriptionEventSchema,
  [SchemaName.Capabilities]: s.CapabilitiesSchema,
};

for (const [id, schema] of Object.entries(NAMED)) {
  schemaRegistry.add(schema, { id });
}

/** The schema published under a given name. */
export function namedSchema(name: SchemaName): z.ZodType {
  return NAMED[name];
}

export interface JsonSchemaExport {
  /** One JSON Schema (draft 2020-12) per published name, cross-referenced by `$ref`. */
  schemas: Record<string, Record<string, unknown>>;
}

/**
 * Exports the unified model as JSON Schema. `refPrefix` controls how schemas
 * point at each other: `#/components/schemas/` for OpenAPI, `#/$defs/` for a
 * standalone JSON Schema bundle.
 *
 * `io: 'input'` describes what callers send (defaults are optional);
 * `io: 'output'` describes what they receive (defaults are always present).
 */
export function exportJsonSchemas(options: { refPrefix: string; io: 'input' | 'output' }): JsonSchemaExport {
  const result = z.toJSONSchema(schemaRegistry, {
    uri: (id) => `${options.refPrefix}${id}`,
    io: options.io,
    unrepresentable: 'any',
  });
  const schemas: Record<string, Record<string, unknown>> = {};
  for (const [id, schema] of Object.entries(result.schemas)) {
    const { $schema: _schema, $id: _id, ...rest } = schema as Record<string, unknown>;
    schemas[id] = rest;
  }
  return { schemas };
}
