import { z } from 'zod';
import * as s from './schemas.js';
import * as routing from './routing/schemas.js';
import * as purchase from './purchase/schemas.js';

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
  IntervalUnit: 'IntervalUnit',
  CancelMode: 'CancelMode',
  ChangeTiming: 'ChangeTiming',
  CheckoutKind: 'CheckoutKind',
  BillingInterval: 'BillingInterval',
  Customer: 'Customer',
  CreatePlanInput: 'CreatePlanInput',
  Plan: 'Plan',
  RedirectCheckout: 'RedirectCheckout',
  FormPostCheckout: 'FormPostCheckout',
  RazorpayCheckout: 'RazorpayCheckout',
  CashfreeCheckout: 'CashfreeCheckout',
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
  VerifyCheckoutInput: 'VerifyCheckoutInput',
  CheckoutVerification: 'CheckoutVerification',
  WebhookRequest: 'WebhookRequest',
  SubscriptionEvent: 'SubscriptionEvent',
  Capabilities: 'Capabilities',
  ProviderKind: 'ProviderKind',
  Platform: 'Platform',
  ChannelPolicy: 'ChannelPolicy',
  SalesChannel: 'SalesChannel',
  ProductKind: 'ProductKind',
  PaymentStatus: 'PaymentStatus',
  StoreProduct: 'StoreProduct',
  AppleStoreKitCheckout: 'AppleStoreKitCheckout',
  GooglePlayBillingCheckout: 'GooglePlayBillingCheckout',
  CreatePaymentInput: 'CreatePaymentInput',
  Payment: 'Payment',
  VerifyPaymentInput: 'VerifyPaymentInput',
  PaymentVerification: 'PaymentVerification',
  RefundPaymentInput: 'RefundPaymentInput',
  ExternalTransactionReport: 'ExternalTransactionReport',
  ExternalTransactionRefund: 'ExternalTransactionRefund',
  ExternalTransactionRecord: 'ExternalTransactionRecord',
  RouteExclusion: 'RouteExclusion',
  RouteOutcomeKind: 'RouteOutcomeKind',
  RouteOutcomeResult: 'RouteOutcomeResult',
  CircuitState: 'CircuitState',
  RouteNeeds: 'RouteNeeds',
  RouteRequest: 'RouteRequest',
  RouteFactors: 'RouteFactors',
  RouteCandidate: 'RouteCandidate',
  RoutingDecision: 'RoutingDecision',
  RouteOutcome: 'RouteOutcome',
  RoutingStrategy: 'RoutingStrategy',
  SessionStatus: 'SessionStatus',
  EntitlementStatus: 'EntitlementStatus',
  ReportKind: 'ReportKind',
  ReportStatus: 'ReportStatus',
  FlushOutcome: 'FlushOutcome',
  AttemptOutcome: 'AttemptOutcome',
  ProductPlan: 'ProductPlan',
  Product: 'Product',
  PlatformPolicy: 'PlatformPolicy',
  PurchaseOption: 'PurchaseOption',
  PurchaseAttempt: 'PurchaseAttempt',
  PurchaseSession: 'PurchaseSession',
  EntitlementItem: 'EntitlementItem',
  Entitlements: 'Entitlements',
  StartPurchaseInput: 'StartPurchaseInput',
  ChooseAlternativeInput: 'ChooseAlternativeInput',
  CompletePurchaseInput: 'CompletePurchaseInput',
  FlushOptions: 'FlushOptions',
  FlushEntry: 'FlushEntry',
  FlushResult: 'FlushResult',
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
  [SchemaName.IntervalUnit]: s.IntervalUnitSchema,
  [SchemaName.CancelMode]: s.CancelModeSchema,
  [SchemaName.ChangeTiming]: s.ChangeTimingSchema,
  [SchemaName.CheckoutKind]: s.CheckoutKindSchema,
  [SchemaName.BillingInterval]: s.BillingIntervalSchema,
  [SchemaName.Customer]: s.CustomerSchema,
  [SchemaName.CreatePlanInput]: s.CreatePlanInputSchema,
  [SchemaName.Plan]: s.PlanSchema,
  [SchemaName.RedirectCheckout]: s.RedirectCheckoutSchema,
  [SchemaName.FormPostCheckout]: s.FormPostCheckoutSchema,
  [SchemaName.RazorpayCheckout]: s.RazorpayCheckoutSchema,
  [SchemaName.CashfreeCheckout]: s.CashfreeCheckoutSchema,
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
  [SchemaName.VerifyCheckoutInput]: s.VerifyCheckoutInputSchema,
  [SchemaName.CheckoutVerification]: s.CheckoutVerificationSchema,
  [SchemaName.WebhookRequest]: s.WebhookRequestSchema,
  [SchemaName.SubscriptionEvent]: s.SubscriptionEventSchema,
  [SchemaName.Capabilities]: s.CapabilitiesSchema,
  [SchemaName.ProviderKind]: s.ProviderKindSchema,
  [SchemaName.Platform]: s.PlatformSchema,
  [SchemaName.ChannelPolicy]: s.ChannelPolicySchema,
  [SchemaName.SalesChannel]: s.SalesChannelSchema,
  [SchemaName.ProductKind]: s.ProductKindSchema,
  [SchemaName.PaymentStatus]: s.PaymentStatusSchema,
  [SchemaName.StoreProduct]: s.StoreProductSchema,
  [SchemaName.AppleStoreKitCheckout]: s.AppleStoreKitCheckoutSchema,
  [SchemaName.GooglePlayBillingCheckout]: s.GooglePlayBillingCheckoutSchema,
  [SchemaName.CreatePaymentInput]: s.CreatePaymentInputSchema,
  [SchemaName.Payment]: s.PaymentSchema,
  [SchemaName.VerifyPaymentInput]: s.VerifyPaymentInputSchema,
  [SchemaName.PaymentVerification]: s.PaymentVerificationSchema,
  [SchemaName.RefundPaymentInput]: s.RefundPaymentInputSchema,
  [SchemaName.ExternalTransactionReport]: s.ExternalTransactionReportSchema,
  [SchemaName.ExternalTransactionRefund]: s.ExternalTransactionRefundSchema,
  [SchemaName.ExternalTransactionRecord]: s.ExternalTransactionRecordSchema,
  [SchemaName.RouteExclusion]: routing.RouteExclusionSchema,
  [SchemaName.RouteOutcomeKind]: routing.RouteOutcomeKindSchema,
  [SchemaName.RouteOutcomeResult]: routing.RouteOutcomeResultSchema,
  [SchemaName.CircuitState]: routing.CircuitStateSchema,
  [SchemaName.RouteNeeds]: routing.RouteNeedsSchema,
  [SchemaName.RouteRequest]: routing.RouteRequestSchema,
  [SchemaName.RouteFactors]: routing.RouteFactorsSchema,
  [SchemaName.RouteCandidate]: routing.RouteCandidateSchema,
  [SchemaName.RoutingDecision]: routing.RoutingDecisionSchema,
  [SchemaName.RouteOutcome]: routing.RouteOutcomeSchema,
  [SchemaName.RoutingStrategy]: routing.RoutingStrategySchema,
  [SchemaName.SessionStatus]: purchase.SessionStatusSchema,
  [SchemaName.EntitlementStatus]: purchase.EntitlementStatusSchema,
  [SchemaName.ReportKind]: purchase.ReportKindSchema,
  [SchemaName.ReportStatus]: purchase.ReportStatusSchema,
  [SchemaName.FlushOutcome]: purchase.FlushOutcomeSchema,
  [SchemaName.AttemptOutcome]: purchase.AttemptOutcomeSchema,
  [SchemaName.ProductPlan]: purchase.ProductPlanSchema,
  [SchemaName.Product]: purchase.ProductSchema,
  [SchemaName.PlatformPolicy]: purchase.PlatformPolicySchema,
  [SchemaName.PurchaseOption]: purchase.PurchaseOptionSchema,
  [SchemaName.PurchaseAttempt]: purchase.PurchaseAttemptSchema,
  [SchemaName.PurchaseSession]: purchase.PurchaseSessionSchema,
  [SchemaName.EntitlementItem]: purchase.EntitlementItemSchema,
  [SchemaName.Entitlements]: purchase.EntitlementsSchema,
  [SchemaName.StartPurchaseInput]: purchase.StartPurchaseInputSchema,
  [SchemaName.ChooseAlternativeInput]: purchase.ChooseAlternativeInputSchema,
  [SchemaName.CompletePurchaseInput]: purchase.CompletePurchaseInputSchema,
  [SchemaName.FlushOptions]: purchase.FlushOptionsSchema,
  [SchemaName.FlushEntry]: purchase.FlushEntrySchema,
  [SchemaName.FlushResult]: purchase.FlushResultSchema,
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

type JsonObject = Record<string, unknown>;

/** Zod gives every integer these bounds; they only restate what a JavaScript number can hold. */
const SAFE_INTEGER_BOUNDS: readonly number[] = [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
const BOUND_KEYWORDS = ['minimum', 'maximum'] as const;

/**
 * Removes `minimum` / `maximum` keywords whose value is merely the JavaScript
 * safe-integer limit (Zod adds them to every `z.number().int()`), in place.
 * Real bounds such as `minimum: 1` or `maximum: 100` are kept. Generated
 * clients otherwise carry meaningless range checks.
 */
export function stripSafeIntegerBounds<T>(node: T): T {
  if (Array.isArray(node)) {
    for (const item of node) stripSafeIntegerBounds(item);
  } else if (node !== null && typeof node === 'object') {
    const object = node as JsonObject;
    for (const keyword of BOUND_KEYWORDS) {
      const bound = object[keyword];
      if (typeof bound === 'number' && SAFE_INTEGER_BOUNDS.includes(bound)) delete object[keyword];
    }
    for (const value of Object.values(object)) stripSafeIntegerBounds(value);
  }
  return node;
}

const REF = '$ref';

function resolveComponent(schemas: Record<string, JsonObject>, refPrefix: string, ref: unknown): JsonObject | undefined {
  return typeof ref === 'string' && ref.startsWith(refPrefix) ? schemas[ref.slice(refPrefix.length)] : undefined;
}

/** The string `const` a variant pins its property to, or undefined. */
function constantOf(variant: JsonObject, property: string): string | undefined {
  const properties = variant.properties as Record<string, JsonObject> | undefined;
  const value = properties?.[property]?.const;
  const required = Array.isArray(variant.required) && variant.required.includes(property);
  return required && typeof value === 'string' ? value : undefined;
}

/**
 * Adds an OpenAPI `discriminator` to every component that is a `oneOf` of
 * `$ref`s to object components which all pin one required property to a
 * distinct string `const` (what a Zod `discriminatedUnion` of named variants
 * exports as). Zod 4 cannot express the keyword itself. The mapping goes from
 * each constant to its variant component, so a generator can pick the class by
 * `kind` instead of trying every variant. Done in place; schemas that do not
 * fit the pattern are left untouched.
 */
export function addDiscriminators(schemas: Record<string, JsonObject>, refPrefix: string): void {
  for (const schema of Object.values(schemas)) {
    const variants = schema.oneOf;
    if (!Array.isArray(variants) || variants.length === 0 || schema.discriminator !== undefined) continue;
    const targets = variants.map((variant) => resolveComponent(schemas, refPrefix, (variant as JsonObject)[REF]));
    const first = targets[0];
    if (!first || targets.some((target) => target === undefined)) continue;
    const candidates = Object.keys((first.properties as JsonObject | undefined) ?? {});
    for (const propertyName of candidates) {
      const values = targets.map((target) => constantOf(target as JsonObject, propertyName));
      if (values.some((value) => value === undefined) || new Set(values).size !== values.length) continue;
      const mapping: Record<string, string> = {};
      variants.forEach((variant, index) => {
        mapping[values[index] as string] = (variant as JsonObject)[REF] as string;
      });
      schema.discriminator = { propertyName, mapping };
      break;
    }
  }
}

/**
 * Exports the unified model as JSON Schema. `refPrefix` controls how schemas
 * point at each other: `#/components/schemas/` for OpenAPI, `#/$defs/` for a
 * standalone JSON Schema bundle.
 *
 * `io: 'input'` describes what callers send (defaults are optional);
 * `io: 'output'` describes what they receive (defaults are always present).
 *
 * `extra` publishes further named schemas in the same document (the HTTP
 * service's own). They share one registry with the unified model, so a schema
 * that appears in both, such as `Provider`, is a `$ref` everywhere instead of
 * being inlined.
 */
export function exportJsonSchemas(options: {
  refPrefix: string;
  io: 'input' | 'output';
  extra?: Record<string, z.ZodType>;
}): JsonSchemaExport {
  let registry = schemaRegistry;
  if (options.extra) {
    registry = z.registry<{ id: string }>();
    for (const [id, schema] of Object.entries({ ...NAMED, ...options.extra })) registry.add(schema, { id });
  }
  const result = z.toJSONSchema(registry, {
    uri: (id) => `${options.refPrefix}${id}`,
    io: options.io,
    unrepresentable: 'any',
  });
  const schemas: Record<string, Record<string, unknown>> = {};
  for (const [id, schema] of Object.entries(result.schemas)) {
    const { $schema: _schema, $id: _id, ...rest } = schema as Record<string, unknown>;
    schemas[id] = stripSafeIntegerBounds(rest);
  }
  return { schemas };
}
