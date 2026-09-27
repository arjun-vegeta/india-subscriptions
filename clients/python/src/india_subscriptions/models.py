# GENERATED FILE - DO NOT EDIT.
# Source: openapi/openapi.json (generated from the TypeScript Zod schemas by `npm run openapi`).
# Regenerate with: clients/python/scripts/generate_models.sh
# tests/test_models_generated.py fails when this file drifts from the spec.
# ruff: noqa
# mypy: ignore-errors

from __future__ import annotations

from enum import Enum
from typing import Annotated, Any, Dict, Literal, Optional, Union

from pydantic import (
    AnyUrl,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    StringConstraints,
)


class Provider(str, Enum):
    """
    A supported payment gateway.
    """

    RAZORPAY = 'razorpay'
    CASHFREE = 'cashfree'
    PAYU = 'payu'
    PHONEPE = 'phonepe'
    PAYTM = 'paytm'


class Currency(str, Enum):
    """
    ISO 4217 currency code. Only INR is supported.
    """

    INR = 'INR'


class SubscriptionStatus(str, Enum):
    """
    Normalised subscription lifecycle. Each gateway's own status is preserved verbatim in `providerStatus`. `cancelled`, `completed`, `expired` and `failed` are terminal.
    """

    CREATED = 'created'
    PENDING_AUTHORIZATION = 'pending_authorization'
    TRIALING = 'trialing'
    ACTIVE = 'active'
    PAST_DUE = 'past_due'
    HALTED = 'halted'
    PAUSED = 'paused'
    CANCELLED = 'cancelled'
    COMPLETED = 'completed'
    EXPIRED = 'expired'
    FAILED = 'failed'


class ChargeStatus(str, Enum):
    """
    Normalised status of a charge (one debit).
    """

    SCHEDULED = 'scheduled'
    PENDING = 'pending'
    SUCCEEDED = 'succeeded'
    FAILED = 'failed'
    CANCELLED = 'cancelled'
    REFUNDED = 'refunded'
    PARTIALLY_REFUNDED = 'partially_refunded'


class ChargeKind(str, Enum):
    """
    `authorization` is the small verification debit taken when the mandate is set up, `recurring` is a debit for a billing cycle, `upfront` is a one-off amount such as a setup fee or add-on.
    """

    AUTHORIZATION = 'authorization'
    RECURRING = 'recurring'
    UPFRONT = 'upfront'


class RefundStatus(str, Enum):
    """
    Status of a refund.
    """

    PENDING = 'pending'
    SUCCEEDED = 'succeeded'
    FAILED = 'failed'


class PaymentMethod(str, Enum):
    """
    `upi` is a UPI Autopay mandate, `card` a card standing instruction, `enach` an eNACH e-mandate on a bank account, `physical_nach` a paper NACH mandate.
    """

    UPI = 'upi'
    CARD = 'card'
    ENACH = 'enach'
    PHYSICAL_NACH = 'physical_nach'


class SchedulingMode(str, Enum):
    """
    Who decides when each recurring debit happens: `gateway` raises every charge on the plan's schedule, `merchant` means the merchant (this library's scheduler) raises each charge.
    """

    GATEWAY = 'gateway'
    MERCHANT = 'merchant'


class EventType(str, Enum):
    """
    Normalised webhook / lifecycle event. `unknown` is a verified event this library does not normalise; inspect `raw`.
    """

    SUBSCRIPTION_AUTHORIZED = 'subscription.authorized'
    SUBSCRIPTION_AUTHORIZATION_FAILED = 'subscription.authorization_failed'
    SUBSCRIPTION_ACTIVATED = 'subscription.activated'
    SUBSCRIPTION_CHARGED = 'subscription.charged'
    SUBSCRIPTION_CHARGE_FAILED = 'subscription.charge_failed'
    SUBSCRIPTION_CHARGE_SCHEDULED = 'subscription.charge_scheduled'
    SUBSCRIPTION_PAST_DUE = 'subscription.past_due'
    SUBSCRIPTION_HALTED = 'subscription.halted'
    SUBSCRIPTION_PAUSED = 'subscription.paused'
    SUBSCRIPTION_RESUMED = 'subscription.resumed'
    SUBSCRIPTION_UPDATED = 'subscription.updated'
    SUBSCRIPTION_CANCELLED = 'subscription.cancelled'
    SUBSCRIPTION_COMPLETED = 'subscription.completed'
    SUBSCRIPTION_EXPIRED = 'subscription.expired'
    REFUND_SUCCEEDED = 'refund.succeeded'
    REFUND_FAILED = 'refund.failed'
    UNKNOWN = 'unknown'


class Environment(str, Enum):
    """
    `test` is the gateway sandbox, `live` is real money.
    """

    TEST = 'test'
    LIVE = 'live'


class IntervalUnit(str, Enum):
    """
    Unit of a billing interval.
    """

    DAY = 'day'
    WEEK = 'week'
    MONTH = 'month'
    YEAR = 'year'


class CancelMode(str, Enum):
    """
    `immediately` stops now with no further charges; `at_period_end` keeps the current paid period, then stops.
    """

    IMMEDIATELY = 'immediately'
    AT_PERIOD_END = 'at_period_end'


class ChangeTiming(str, Enum):
    """
    When a subscription change takes effect: `immediately`, or `at_period_end` (the next cycle boundary).
    """

    IMMEDIATELY = 'immediately'
    AT_PERIOD_END = 'at_period_end'


class CheckoutKind(str, Enum):
    """
    How the customer's browser or app completes mandate authorisation; the `kind` of a `CheckoutInstruction`.
    """

    REDIRECT = 'redirect'
    FORM_POST = 'form_post'
    RAZORPAY_CHECKOUT = 'razorpay_checkout'
    CASHFREE_CHECKOUT = 'cashfree_checkout'


class BillingInterval(BaseModel):
    """
    How often a plan bills.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    unit: IntervalUnit
    """
    The unit of the interval.
    """
    count: Annotated[int, Field(ge=1)]
    """
    Bill every `count` units: `{ unit: 'month', count: 3 }` is quarterly.
    """


class Customer(BaseModel):
    """
    A customer: identity and contact details.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    id: Annotated[Optional[str], Field(min_length=1)] = None
    """
    The gateway's customer id, where one exists.
    """
    name: Annotated[Optional[str], Field(min_length=1)] = None
    """
    The customer's name.
    """
    email: Annotated[
        Optional[str],
        Field(
            pattern="^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
        ),
    ] = None
    """
    The customer's e-mail address.
    """
    phone: Annotated[Optional[str], Field(pattern='^\\+?[0-9]{10,15}$')] = None
    """
    Mobile number; 10 digits or E.164. Adapters format it for their gateway.
    """


class CreatePlanInput(BaseModel):
    """
    Details of a billing plan to create.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    id: Annotated[Optional[str], Field(max_length=40, min_length=1)] = None
    """
    Your own plan id. Used where the gateway lets the merchant choose the id; ignored where the gateway generates one.
    """
    name: Annotated[str, Field(max_length=100, min_length=1)]
    """
    Plan name.
    """
    description: Annotated[Optional[str], Field(max_length=500)] = None
    """
    Plan description.
    """
    amount: Annotated[int, Field(gt=0)]
    """
    Amount charged every cycle, in paise.
    """
    currency: Currency = Currency.INR
    """
    Currency of the plan. Defaults to INR.
    """
    interval: BillingInterval
    """
    How often the plan bills.
    """
    scheduling: Optional[SchedulingMode] = None
    """
    Who raises each charge. Defaults to the gateway's native mode.
    """
    max_amount: Annotated[Optional[int], Field(alias='maxAmount', gt=0)] = None
    """
    Ceiling the mandate allows per debit, in paise. Defaults to `amount`. Set it higher to leave room for upgrades or add-ons.
    """
    max_cycles: Annotated[Optional[int], Field(alias='maxCycles', gt=0)] = None
    """
    Number of cycles after which the plan ends. Omit for open-ended.
    """
    metadata: Optional[dict[str, str]] = None
    """
    Free-form key/value pairs stored with the plan.
    """


class Plan(BaseModel):
    """
    A billing plan.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway that holds the plan.
    """
    id: str
    """
    The plan id to pass back to this library.
    """
    name: str
    """
    Plan name.
    """
    description: Optional[str] = None
    """
    Plan description.
    """
    amount: Annotated[int, Field(ge=0)]
    """
    Amount charged every cycle, in paise.
    """
    currency: Currency
    """
    Currency of the plan.
    """
    interval: Optional[BillingInterval] = None
    """
    How often the plan bills, where known.
    """
    scheduling: SchedulingMode
    """
    Who raises each charge.
    """
    max_amount: Annotated[Optional[int], Field(alias='maxAmount', ge=0)] = None
    """
    Ceiling the mandate allows per debit, in paise.
    """
    max_cycles: Annotated[Optional[int], Field(alias='maxCycles')] = None
    """
    Number of cycles after which the plan ends, where limited.
    """
    provider_status: Annotated[Optional[str], Field(alias='providerStatus')] = None
    """
    The gateway's own plan status, verbatim, where it has one.
    """
    created_at: Annotated[Optional[AwareDatetime], Field(alias='createdAt')] = None
    """
    When the plan was created.
    """
    metadata: Optional[dict[str, str]] = None
    """
    Key/value pairs stored with the plan.
    """
    raw: Optional[Any] = None
    """
    The gateway's response, untouched. Absent when the gateway returned no body.
    """


class RedirectCheckout(BaseModel):
    """
    Authorise by redirecting the customer to a URL.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['redirect']
    """
    Discriminator: send the customer to `url`.
    """
    url: AnyUrl
    """
    The page to send the customer to.
    """


class FormPostCheckout(BaseModel):
    """
    Authorise by auto-submitting an HTML form to the gateway.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['form_post']
    """
    Discriminator: auto-submit an HTML form to `url`.
    """
    url: AnyUrl
    """
    The URL the form is posted to.
    """
    fields: dict[str, str]
    """
    Post these fields exactly as given; they are covered by a hash.
    """


class RazorpayCheckout(BaseModel):
    """
    Authorise with Razorpay Standard Checkout.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['razorpay_checkout']
    """
    Discriminator: open Razorpay Standard Checkout.
    """
    key_id: Annotated[str, Field(alias='keyId')]
    """
    The Razorpay key id to open Checkout with.
    """
    subscription_id: Annotated[str, Field(alias='subscriptionId')]
    """
    The Razorpay subscription id to authorise.
    """
    hosted_url: Annotated[Optional[AnyUrl], Field(alias='hostedUrl')] = None
    """
    Razorpay-hosted authorisation page, usable instead of the JS checkout.
    """
    callback_url: Annotated[Optional[AnyUrl], Field(alias='callbackUrl')] = None
    """
    Where Razorpay Checkout redirects after authorisation (its `callback_url` option).
    """
    prefill: Optional[Customer] = None
    """
    Customer details to prefill in the checkout form.
    """


class CashfreeCheckout(BaseModel):
    """
    Authorise with Cashfree.js `subscriptionsCheckout`.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['cashfree_checkout']
    """
    Discriminator: call Cashfree.js `subscriptionsCheckout`.
    """
    session_id: Annotated[str, Field(alias='sessionId')]
    """
    The subscription session id to pass to Cashfree.js.
    """
    environment: Environment
    """
    Which Cashfree environment to initialise Cashfree.js with.
    """


class Trial(BaseModel):
    """
    Free trial: the mandate is set up now, the first charge happens when the trial ends. Pass exactly one of `days` or `endsAt`.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    days: Annotated[Optional[int], Field(gt=0)] = None
    """
    Trial length in days from now.
    """
    ends_at: Annotated[Optional[AwareDatetime], Field(alias='endsAt')] = None
    """
    Or an exact instant at which the trial ends.
    """


class CreateSubscriptionInput(BaseModel):
    """
    Everything needed to create a subscription.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    reference: Annotated[Optional[str], Field(max_length=60, min_length=1)] = None
    """
    Your own id for this subscription. Sent to the gateway where it accepts a merchant reference, and echoed back on `Subscription.reference`.
    """
    plan: Union[CreatePlanInput, Annotated[str, StringConstraints(min_length=1)]]
    """
    An existing plan id, or plan details to create inline.
    """
    customer: Customer
    """
    The paying customer.
    """
    quantity: Annotated[Optional[int], Field(gt=0)] = None
    """
    Units of the plan billed each cycle. Defaults to 1.
    """
    total_cycles: Annotated[Optional[int], Field(alias='totalCycles', gt=0)] = None
    """
    Total number of recurring charges. Omit to bill until cancelled, where the gateway allows.
    """
    trial: Optional[Trial] = None
    """
    Free trial. Mutually exclusive with `startAt`.
    """
    start_at: Annotated[Optional[AwareDatetime], Field(alias='startAt')] = None
    """
    Delay the first recurring charge to this instant without calling it a trial.
    """
    upfront_amount: Annotated[Optional[int], Field(alias='upfrontAmount', gt=0)] = None
    """
    One-off amount collected together with the authorisation (setup fee or first payment), in paise.
    """
    upfront_label: Annotated[
        Optional[str], Field(alias='upfrontLabel', max_length=100, min_length=1)
    ] = None
    """
    Label shown to the customer for the upfront amount.
    """
    payment_methods: Annotated[
        Optional[list[PaymentMethod]], Field(alias='paymentMethods', min_length=1)
    ] = None
    """
    Restrict the mandate to these payment methods. Omit to allow all the gateway supports.
    """
    authorize_by: Annotated[Optional[AwareDatetime], Field(alias='authorizeBy')] = None
    """
    Deadline for the customer to authorise the mandate.
    """
    mandate_ends_at: Annotated[
        Optional[AwareDatetime], Field(alias='mandateEndsAt')
    ] = None
    """
    When the mandate itself should lapse.
    """
    return_url: Annotated[Optional[AnyUrl], Field(alias='returnUrl')] = None
    """
    Where the gateway sends the customer after authorisation.
    """
    notify_customer: Annotated[Optional[bool], Field(alias='notifyCustomer')] = None
    """
    Let the gateway send its own SMS/email to the customer.
    """
    metadata: Optional[dict[str, str]] = None
    """
    Free-form key/value pairs stored with the subscription.
    """
    idempotency_key: Annotated[
        Optional[str], Field(alias='idempotencyKey', max_length=255, min_length=1)
    ] = None
    """
    Makes the create call safe to retry, where the gateway supports idempotency keys.
    """


class Subscription(BaseModel):
    """
    A subscription (a recurring-payment mandate) at a gateway.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway that holds the subscription.
    """
    id: str
    """
    The identifier to pass back to this library for every later call.
    """
    reference: Optional[str] = None
    """
    Your own reference, where one was supplied.
    """
    plan_id: Annotated[Optional[str], Field(alias='planId')] = None
    """
    The plan the subscription bills.
    """
    status: SubscriptionStatus
    """
    Normalised lifecycle status.
    """
    provider_status: Annotated[str, Field(alias='providerStatus')]
    """
    The gateway's own status, verbatim.
    """
    scheduling: SchedulingMode
    """
    Who raises each charge.
    """
    customer: Optional[Customer] = None
    """
    The paying customer, where known.
    """
    quantity: Optional[int] = None
    """
    Units of the plan billed each cycle.
    """
    amount: Annotated[Optional[int], Field(ge=0)] = None
    """
    Recurring amount per cycle in paise, where known.
    """
    max_amount: Annotated[Optional[int], Field(alias='maxAmount', ge=0)] = None
    """
    Mandate ceiling per debit in paise, where known.
    """
    currency: Optional[Currency] = None
    """
    Currency of the subscription.
    """
    interval: Optional[BillingInterval] = None
    """
    How often the subscription bills, where known.
    """
    total_cycles: Annotated[Optional[int], Field(alias='totalCycles')] = None
    """
    Total number of recurring charges, where limited.
    """
    paid_cycles: Annotated[Optional[int], Field(alias='paidCycles')] = None
    """
    Number of cycles collected so far.
    """
    remaining_cycles: Annotated[Optional[int], Field(alias='remainingCycles')] = None
    """
    Number of cycles still to collect, where limited.
    """
    created_at: Annotated[Optional[AwareDatetime], Field(alias='createdAt')] = None
    """
    When the subscription was created.
    """
    start_at: Annotated[Optional[AwareDatetime], Field(alias='startAt')] = None
    """
    When the first recurring charge is or was due.
    """
    trial_ends_at: Annotated[Optional[AwareDatetime], Field(alias='trialEndsAt')] = None
    """
    Set while `status` is `trialing`: when the trial ends and the first charge is due.
    """
    current_period_start: Annotated[
        Optional[AwareDatetime], Field(alias='currentPeriodStart')
    ] = None
    """
    Start of the current billing period.
    """
    current_period_end: Annotated[
        Optional[AwareDatetime], Field(alias='currentPeriodEnd')
    ] = None
    """
    End of the current billing period.
    """
    next_charge_at: Annotated[Optional[AwareDatetime], Field(alias='nextChargeAt')] = (
        None
    )
    """
    When the next charge is due.
    """
    ended_at: Annotated[Optional[AwareDatetime], Field(alias='endedAt')] = None
    """
    When the subscription ended, if it did.
    """
    mandate_ends_at: Annotated[
        Optional[AwareDatetime], Field(alias='mandateEndsAt')
    ] = None
    """
    When the mandate lapses.
    """
    cancel_at_period_end: Annotated[
        Optional[bool], Field(alias='cancelAtPeriodEnd')
    ] = None
    """
    True when a cancellation is scheduled for the end of the current period.
    """
    payment_method: Annotated[Optional[PaymentMethod], Field(alias='paymentMethod')] = (
        None
    )
    """
    The payment method the mandate was authorised with.
    """
    checkout: Annotated[
        Optional[
            Union[
                RedirectCheckout, FormPostCheckout, RazorpayCheckout, CashfreeCheckout
            ]
        ],
        Field(discriminator='kind'),
    ] = None
    """
    Present on freshly created subscriptions: what the customer must do to authorise.
    """
    metadata: Optional[dict[str, str]] = None
    """
    Key/value pairs stored with the subscription.
    """
    raw: Optional[Any] = None
    """
    The gateway's response, untouched. Absent when the gateway returned no body.
    """


class CancelSubscriptionOptions(BaseModel):
    """
    Options for cancelling a subscription.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    mode: CancelMode = CancelMode.IMMEDIATELY
    """
    When the cancellation takes effect. Defaults to `immediately`.
    """


class PauseSubscriptionOptions(BaseModel):
    """
    Options for pausing a subscription.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    resume_at: Annotated[Optional[AwareDatetime], Field(alias='resumeAt')] = None
    """
    Resume automatically at this instant, where the gateway supports it.
    """


class ResumeSubscriptionOptions(BaseModel):
    """
    Options for resuming a paused subscription.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    next_charge_at: Annotated[Optional[AwareDatetime], Field(alias='nextChargeAt')] = (
        None
    )
    """
    Date of the next charge after resuming, where the gateway needs one.
    """


class UpdateSubscriptionInput(BaseModel):
    """
    Changes to make to a subscription. Pass at least one field to change.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    plan_id: Annotated[Optional[str], Field(alias='planId', min_length=1)] = None
    """
    Move to another plan (upgrade or downgrade).
    """
    quantity: Annotated[Optional[int], Field(gt=0)] = None
    """
    New number of units billed each cycle.
    """
    remaining_cycles: Annotated[Optional[int], Field(alias='remainingCycles', gt=0)] = (
        None
    )
    """
    New number of cycles still to collect.
    """
    amount: Annotated[Optional[int], Field(gt=0)] = None
    """
    New amount per cycle in paise, for mandates that are not plan-based.
    """
    next_charge_at: Annotated[Optional[AwareDatetime], Field(alias='nextChargeAt')] = (
        None
    )
    """
    Move the next charge date.
    """
    mandate_ends_at: Annotated[
        Optional[AwareDatetime], Field(alias='mandateEndsAt')
    ] = None
    """
    New mandate end date.
    """
    timing: ChangeTiming = ChangeTiming.IMMEDIATELY
    """
    When the change takes effect. Defaults to `immediately`.
    """
    notify_customer: Annotated[Optional[bool], Field(alias='notifyCustomer')] = None
    """
    Let the gateway notify the customer of the change.
    """


class Charge(BaseModel):
    """
    One debit against a mandate.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway that holds the charge.
    """
    id: str
    """
    The gateway's payment id (or your charge id where the gateway keys on that).
    """
    reference: Optional[str] = None
    """
    Your own charge id, where one was supplied.
    """
    subscription_id: Annotated[Optional[str], Field(alias='subscriptionId')] = None
    """
    The subscription the charge belongs to.
    """
    kind: ChargeKind
    """
    What the debit is for.
    """
    status: ChargeStatus
    """
    Normalised charge status.
    """
    provider_status: Annotated[Optional[str], Field(alias='providerStatus')] = None
    """
    The gateway's own status, verbatim.
    """
    amount: Annotated[int, Field(ge=0)]
    """
    Amount of the debit in paise.
    """
    currency: Optional[Currency] = None
    """
    Currency of the debit.
    """
    cycle: Optional[int] = None
    """
    1-based billing cycle number, where known.
    """
    scheduled_at: Annotated[Optional[AwareDatetime], Field(alias='scheduledAt')] = None
    """
    When the debit is or was scheduled.
    """
    paid_at: Annotated[Optional[AwareDatetime], Field(alias='paidAt')] = None
    """
    When the debit succeeded.
    """
    failure_code: Annotated[Optional[str], Field(alias='failureCode')] = None
    """
    The gateway's failure code, where the debit failed.
    """
    failure_reason: Annotated[Optional[str], Field(alias='failureReason')] = None
    """
    Human-readable reason the debit failed.
    """
    payment_method: Annotated[Optional[PaymentMethod], Field(alias='paymentMethod')] = (
        None
    )
    """
    The payment method the debit used.
    """
    refunded_amount: Annotated[Optional[int], Field(alias='refundedAmount', ge=0)] = (
        None
    )
    """
    Amount refunded so far, in paise.
    """
    raw: Optional[Any] = None
    """
    The gateway's response, untouched. Absent when the gateway returned no body.
    """


class CreateChargeInput(BaseModel):
    """
    A merchant-raised recurring debit, for gateways/plans the merchant schedules.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    subscription_id: Annotated[str, Field(alias='subscriptionId', min_length=1)]
    """
    The subscription to debit.
    """
    charge_id: Annotated[str, Field(alias='chargeId', max_length=50, min_length=1)]
    """
    Your unique id for this debit. Reusing an id must never debit twice, so derive it from the subscription and cycle (the scheduler does).
    """
    amount: Annotated[int, Field(gt=0)]
    """
    Amount to debit, in paise.
    """
    scheduled_at: Annotated[Optional[AwareDatetime], Field(alias='scheduledAt')] = None
    """
    When to debit. Omit for the earliest the gateway allows.
    """
    invoice_number: Annotated[
        Optional[str], Field(alias='invoiceNumber', max_length=50, min_length=1)
    ] = None
    """
    Invoice number shown to the customer where the gateway supports it.
    """
    description: Annotated[Optional[str], Field(max_length=200)] = None
    """
    Description of the debit.
    """
    customer: Optional[Customer] = None
    """
    The paying customer.
    """
    metadata: Optional[dict[str, str]] = None
    """
    Free-form key/value pairs stored with the charge.
    """


class NotifyChargeInput(BaseModel):
    """
    The advance notice RBI rules require before debiting a mandate.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    subscription_id: Annotated[str, Field(alias='subscriptionId', min_length=1)]
    """
    The subscription that will be debited.
    """
    notification_id: Annotated[
        str, Field(alias='notificationId', max_length=50, min_length=1)
    ]
    """
    Your unique id for this notification.
    """
    amount: Annotated[int, Field(gt=0)]
    """
    Amount that will be debited, in paise.
    """
    debit_at: Annotated[AwareDatetime, Field(alias='debitAt')]
    """
    The date the debit will be attempted.
    """
    invoice_number: Annotated[
        Optional[str], Field(alias='invoiceNumber', max_length=50, min_length=1)
    ] = None
    """
    Invoice number to show the customer.
    """


class ChargeNotification(BaseModel):
    """
    The result of sending a pre-debit notification.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway that holds the notification.
    """
    id: str
    """
    The notification id.
    """
    subscription_id: Annotated[str, Field(alias='subscriptionId')]
    """
    The subscription that will be debited.
    """
    accepted: bool
    """
    True when the gateway accepted the notification for delivery.
    """
    provider_status: Annotated[Optional[str], Field(alias='providerStatus')] = None
    """
    The gateway's own status, verbatim.
    """
    amount: Annotated[int, Field(ge=0)]
    """
    Amount that will be debited, in paise.
    """
    debit_at: Annotated[AwareDatetime, Field(alias='debitAt')]
    """
    The date the debit will be attempted.
    """
    invoice_number: Annotated[Optional[str], Field(alias='invoiceNumber')] = None
    """
    Carry this into the matching charge call where the gateway requires it.
    """
    raw: Optional[Any] = None
    """
    The gateway's response, untouched. Absent when the gateway returned no body.
    """


class ListChargesOptions(BaseModel):
    """
    Options for listing the charges of a subscription.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    limit: Annotated[Optional[int], Field(ge=1, le=100)] = None
    """
    Most charges to return.
    """


class RefundInput(BaseModel):
    """
    A refund of a charge.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    subscription_id: Annotated[
        Optional[str], Field(alias='subscriptionId', min_length=1)
    ] = None
    """
    Required by gateways that scope payments under a subscription.
    """
    charge_id: Annotated[str, Field(alias='chargeId', min_length=1)]
    """
    The charge to refund.
    """
    refund_id: Annotated[str, Field(alias='refundId', max_length=40, min_length=1)]
    """
    Your unique id for this refund.
    """
    amount: Annotated[Optional[int], Field(gt=0)] = None
    """
    Amount to refund in paise. Omit to refund the full charge.
    """
    reason: Annotated[Optional[str], Field(max_length=250)] = None
    """
    Why the charge is refunded.
    """


class Refund(BaseModel):
    """
    A refund of a charge.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway that holds the refund.
    """
    id: str
    """
    The gateway's refund id.
    """
    reference: Optional[str] = None
    """
    Your own refund id, where one was supplied.
    """
    charge_id: Annotated[str, Field(alias='chargeId')]
    """
    The charge that was refunded.
    """
    subscription_id: Annotated[Optional[str], Field(alias='subscriptionId')] = None
    """
    The subscription the charge belongs to.
    """
    status: RefundStatus
    """
    Normalised refund status.
    """
    provider_status: Annotated[Optional[str], Field(alias='providerStatus')] = None
    """
    The gateway's own status, verbatim.
    """
    amount: Annotated[int, Field(ge=0)]
    """
    Amount refunded, in paise.
    """
    currency: Optional[Currency] = None
    """
    Currency of the refund.
    """
    created_at: Annotated[Optional[AwareDatetime], Field(alias='createdAt')] = None
    """
    When the refund was created.
    """
    raw: Optional[Any] = None
    """
    The gateway's response, untouched. Absent when the gateway returned no body.
    """


class VerifyCheckoutInput(BaseModel):
    """
    What the HTTP service and the facade accept when verifying a checkout result.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    result: dict[str, Any]
    """
    The fields the gateway handed back to the browser or return URL, untouched.
    """
    expected_subscription_id: Annotated[
        Optional[str], Field(alias='expectedSubscriptionId', min_length=1)
    ] = None
    """
    The subscription id (or your reference) that your server stored when it created the subscription. When given, a result that verifies but belongs to a different subscription is rejected, so a customer cannot replay the authorisation of one subscription to unlock another.
    """


class CheckoutVerification(BaseModel):
    """
    The outcome of verifying a checkout result.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway that issued the result.
    """
    subscription_id: Annotated[str, Field(alias='subscriptionId')]
    """
    The subscription id to store and use for later calls.
    """
    reference: Optional[str] = None
    """
    Your own reference for the subscription, where known.
    """
    authorized: bool
    """
    True when the customer's authorisation succeeded.
    """
    status: Optional[SubscriptionStatus] = None
    """
    The subscription status the result implies, where known.
    """
    charge: Optional[Charge] = None
    """
    The authorisation or upfront charge, where the result carries one.
    """
    raw: Optional[Any] = None
    """
    The verified gateway data, untouched. Absent when there is none.
    """


class WebhookRequest(BaseModel):
    """
    A webhook request as received from a gateway.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    raw_body: Annotated[str, Field(alias='rawBody')]
    """
    The exact bytes of the request body as a string. Do not re-serialise parsed JSON.
    """
    headers: dict[str, Union[str, list[str]]]
    """
    The request headers, with lower-case names.
    """


class SubscriptionEvent(BaseModel):
    """
    A verified, normalised webhook event.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    id: str
    """
    Stable id for de-duplication: gateways deliver the same event more than once.
    """
    provider: Provider
    """
    The gateway that sent the event.
    """
    type: EventType
    """
    Normalised event type.
    """
    provider_event_type: Annotated[str, Field(alias='providerEventType')]
    """
    The gateway's own event name, verbatim.
    """
    occurred_at: Annotated[Optional[AwareDatetime], Field(alias='occurredAt')] = None
    """
    When the event happened, where the gateway says.
    """
    subscription_id: Annotated[Optional[str], Field(alias='subscriptionId')] = None
    """
    The subscription the event is about.
    """
    subscription: Optional[Subscription] = None
    """
    The subscription, where the event carries it.
    """
    charge: Optional[Charge] = None
    """
    The charge, where the event carries it.
    """
    refund: Optional[Refund] = None
    """
    The refund, where the event carries it.
    """
    raw: Optional[Any] = None
    """
    The gateway's webhook payload, untouched. Absent when there is none.
    """


class Capabilities(BaseModel):
    """
    What a gateway adapter can do, so callers never have to guess.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway these capabilities describe.
    """
    scheduling: Annotated[list[SchedulingMode], Field(min_length=1)]
    """
    Scheduling modes available; the first is the default.
    """
    gateway_plans: Annotated[bool, Field(alias='gatewayPlans')]
    """
    The gateway stores plan objects (otherwise plans exist only in your code).
    """
    trial: bool
    """
    Free trials are supported.
    """
    upfront_amount: Annotated[bool, Field(alias='upfrontAmount')]
    """
    An upfront amount can be collected with the authorisation.
    """
    quantity: bool
    """
    A subscription can bill several units of a plan.
    """
    pause: bool
    """
    A subscription can be paused.
    """
    resume: bool
    """
    A paused subscription can be resumed.
    """
    cancel_at_period_end: Annotated[bool, Field(alias='cancelAtPeriodEnd')]
    """
    A subscription can be cancelled at the end of the paid period.
    """
    change_plan: Annotated[bool, Field(alias='changePlan')]
    """
    A subscription can move to another plan.
    """
    merchant_charges: Annotated[bool, Field(alias='merchantCharges')]
    """
    The merchant can raise debits itself (`createCharge`).
    """
    merchant_pre_debit_notification: Annotated[
        bool, Field(alias='merchantPreDebitNotification')
    ]
    """
    The merchant must send the pre-debit notification itself (`notifyCharge`).
    """
    merchant_charge_lead_hours: Annotated[
        Optional[int], Field(alias='merchantChargeLeadHours', ge=0)
    ] = None
    """
    Hours before the debit date by which a merchant-raised charge must be created (with `scheduledAt` set), for gateways that send the pre-debit notification themselves once the charge exists. Absent or 0 means a charge can be raised on the due date itself.
    """
    merchant_charge_max_ahead_hours: Annotated[
        Optional[int], Field(alias='merchantChargeMaxAheadHours', gt=0)
    ] = None
    """
    Furthest ahead, in hours, that a merchant-raised charge may be scheduled.
    """
    list_charges: Annotated[bool, Field(alias='listCharges')]
    """
    The charges of a subscription can be listed.
    """
    refunds: bool
    """
    Charges can be refunded.
    """
    signed_webhooks: Annotated[bool, Field(alias='signedWebhooks')]
    """
    Webhooks carry a signature this library verifies.
    """
    idempotency_keys: Annotated[bool, Field(alias='idempotencyKeys')]
    """
    Create calls accept an idempotency key.
    """
    payment_methods: Annotated[list[PaymentMethod], Field(alias='paymentMethods')]
    """
    The payment methods mandates can be authorised with.
    """


class ErrorCode(str, Enum):
    """
    A stable error code: one of the library's `ErrorCode`s or one of the service's own (`UNAUTHORIZED`, `METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`). Branch on this, never on the message.
    """

    CONFIG = 'CONFIG'
    VALIDATION = 'VALIDATION'
    UNSUPPORTED = 'UNSUPPORTED'
    NOT_FOUND = 'NOT_FOUND'
    AUTH = 'AUTH'
    CONFLICT = 'CONFLICT'
    RATE_LIMITED = 'RATE_LIMITED'
    PROVIDER_ERROR = 'PROVIDER_ERROR'
    PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE'
    UNEXPECTED_RESPONSE = 'UNEXPECTED_RESPONSE'
    NETWORK = 'NETWORK'
    TIMEOUT = 'TIMEOUT'
    OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN'
    SIGNATURE_INVALID = 'SIGNATURE_INVALID'
    INTERNAL_ERROR = 'INTERNAL_ERROR'
    UNAUTHORIZED = 'UNAUTHORIZED'
    METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED'
    PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE'


class HealthStatus(str, Enum):
    """
    `ok` when the service is up.
    """

    OK = 'ok'


class WebhookReceipt(BaseModel):
    """
    Acknowledgement of a webhook the service verified.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    received: Annotated[int, Field(ge=0)]
    """
    Number of events the gateway's webhook carried.
    """


class WebhookPayload(RootModel[dict[str, Any]]):
    root: dict[str, Any]
    """
    The gateway's webhook body, exactly as the gateway sent it.
    """


class TickRequest(BaseModel):
    """
    Options for one run of the billing scheduler.
    """

    model_config = ConfigDict(
        extra='forbid',
        populate_by_name=True,
    )
    limit: Annotated[Optional[int], Field(ge=1)] = None
    """
    Most schedules to process in this run.
    """


class OpenApiDocument(BaseModel):
    """
    This API as an OpenAPI 3.1 document.
    """

    model_config = ConfigDict(
        extra='allow',
        populate_by_name=True,
    )
    __annotations__ = {
        '__pydantic_extra__': Dict[str, Any],
    }
    openapi: str
    """
    The OpenAPI version of the document.
    """


class LibraryErrorCode(str, Enum):
    """
    Stable error code of this library. Branch on it, never on the message.
    """

    CONFIG = 'CONFIG'
    VALIDATION = 'VALIDATION'
    UNSUPPORTED = 'UNSUPPORTED'
    NOT_FOUND = 'NOT_FOUND'
    AUTH = 'AUTH'
    CONFLICT = 'CONFLICT'
    RATE_LIMITED = 'RATE_LIMITED'
    PROVIDER_ERROR = 'PROVIDER_ERROR'
    PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE'
    UNEXPECTED_RESPONSE = 'UNEXPECTED_RESPONSE'
    NETWORK = 'NETWORK'
    TIMEOUT = 'TIMEOUT'
    OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN'
    SIGNATURE_INVALID = 'SIGNATURE_INVALID'
    INTERNAL_ERROR = 'INTERNAL_ERROR'


class GatewayEventsDelivery(BaseModel):
    """
    A delivery of gateway webhook events to the events webhook.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['gateway']
    """
    Always `gateway`: tells this delivery from a scheduler one.
    """
    provider: Provider
    """
    The gateway whose webhook carried the events.
    """
    events: Annotated[list[SubscriptionEvent], Field(min_length=1)]
    """
    The verified, normalised events of one gateway webhook, in the order the gateway sent them. Each has an `id` to de-duplicate on.
    """


class Error(BaseModel):
    """
    The failure, for failure events.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    code: LibraryErrorCode
    """
    Error code of the failure.
    """
    message: str
    """
    Human-readable explanation of the failure.
    """


class SchedulerEventType(str, Enum):
    """
    What happened to a schedule, as reported to the `onEvent` listener.
    """

    SCHEDULE_REGISTERED = 'schedule.registered'
    SCHEDULE_ACTIVATED = 'schedule.activated'
    SCHEDULE_PAUSED = 'schedule.paused'
    SCHEDULE_RESUMED = 'schedule.resumed'
    SCHEDULE_CANCELLED = 'schedule.cancelled'
    SCHEDULE_UPDATED = 'schedule.updated'
    SCHEDULE_COMPLETED = 'schedule.completed'
    SCHEDULE_HALTED = 'schedule.halted'
    NOTIFICATION_SENT = 'notification.sent'
    NOTIFICATION_FAILED = 'notification.failed'
    CHARGE_SUCCEEDED = 'charge.succeeded'
    CHARGE_FAILED = 'charge.failed'
    CHARGE_OUTCOME_UNKNOWN = 'charge.outcome_unknown'
    CHARGE_OUTCOME_OVERDUE = 'charge.outcome_overdue'
    CYCLE_FAILED = 'cycle.failed'
    CYCLE_SKIPPED = 'cycle.skipped'
    CHARGE_IN_FLIGHT = 'charge.in_flight'


class ScheduleStatus(str, Enum):
    """
    Lifecycle of one scheduled subscription: pending_authorization (nothing is billed yet), active, paused, halted (retries exhausted), cancelled or completed (all cycles collected or the mandate ended).
    """

    PENDING_AUTHORIZATION = 'pending_authorization'
    ACTIVE = 'active'
    PAUSED = 'paused'
    CANCELLED = 'cancelled'
    COMPLETED = 'completed'
    HALTED = 'halted'


class ScheduleStatusReason(str, Enum):
    """
    Why a schedule is in its current status, for dashboards and audit logs.
    """

    AUTHORIZATION_TIMEOUT = 'authorization_timeout'
    AUTHORIZATION_FAILED = 'authorization_failed'
    MANDATE_EXPIRED = 'mandate_expired'
    CANCELLED_BY_MERCHANT = 'cancelled_by_merchant'
    CANCELLED_BY_GATEWAY = 'cancelled_by_gateway'
    PAUSED_BY_MERCHANT = 'paused_by_merchant'
    PAUSED_BY_GATEWAY = 'paused_by_gateway'
    HALTED_BY_GATEWAY = 'halted_by_gateway'
    RETRIES_EXHAUSTED = 'retries_exhausted'
    ALL_CYCLES_COLLECTED = 'all_cycles_collected'
    FINAL_CYCLE_SKIPPED = 'final_cycle_skipped'
    MANDATE_ENDED = 'mandate_ended'


class ErrorDetail(BaseModel):
    """
    The error: a stable code, a message and, for gateway failures, what the gateway said.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    code: ErrorCode
    """
    What went wrong. Branch on this, never on `message`.
    """
    message: str
    """
    Human-readable explanation. Do not branch on it.
    """
    provider: Optional[Provider] = None
    """
    The gateway involved, where one was.
    """
    http_status: Annotated[Optional[int], Field(alias='httpStatus')] = None
    """
    The gateway's HTTP status, when it answered. This is not the status of this response.
    """
    provider_code: Annotated[Optional[str], Field(alias='providerCode')] = None
    """
    The gateway's own error code, verbatim.
    """
    retryable: bool
    """
    True when repeating the same call later is safe and may succeed.
    """


class Health(BaseModel):
    """
    The service health.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    status: HealthStatus
    """
    Service status.
    """
    providers: list[Provider]
    """
    The gateways this service is configured with.
    """


class TickError(BaseModel):
    """
    A failure of one schedule during a tick.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    schedule_id: Annotated[str, Field(alias='scheduleId')]
    """
    The schedule that failed.
    """
    code: LibraryErrorCode
    """
    Error code of the failure.
    """
    message: str
    """
    Human-readable explanation of the failure.
    """


class TickResult(BaseModel):
    """
    What one run of the billing scheduler did. A failing schedule shows up in `errors`; the others are unaffected.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    at: AwareDatetime
    """
    The instant the tick ran.
    """
    due: Annotated[int, Field(ge=0)]
    """
    Schedules the store reported as due.
    """
    locked: Annotated[int, Field(ge=0)]
    """
    Due schedules skipped because another worker held their lock.
    """
    notified: Annotated[int, Field(ge=0)]
    """
    Pre-debit notifications accepted by the gateway.
    """
    charged: Annotated[int, Field(ge=0)]
    """
    `createCharge` calls made.
    """
    reconciled: Annotated[int, Field(ge=0)]
    """
    `getCharge` reconciliations made.
    """
    succeeded: Annotated[int, Field(ge=0)]
    """
    Cycles that became collected.
    """
    failed: Annotated[int, Field(ge=0)]
    """
    Debit attempts that failed.
    """
    awaiting: Annotated[int, Field(ge=0)]
    """
    Cycles left waiting for the gateway's final answer.
    """
    completed: Annotated[int, Field(ge=0)]
    """
    Schedules that completed.
    """
    halted: Annotated[int, Field(ge=0)]
    """
    Schedules halted because a cycle exhausted its attempts.
    """
    expired: Annotated[int, Field(ge=0)]
    """
    Pending-authorisation schedules cancelled by their timeout.
    """
    errors: list[TickError]
    """
    Schedules that failed during this tick; the others are unaffected.
    """


class SchedulerWebhookEvent(BaseModel):
    """
    A state change of a billing schedule, with a stable id.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    type: SchedulerEventType
    """
    What happened.
    """
    at: AwareDatetime
    """
    When it happened.
    """
    schedule_id: Annotated[str, Field(alias='scheduleId')]
    """
    The schedule it happened to.
    """
    provider: Provider
    """
    The gateway holding the mandate.
    """
    subscription_id: Annotated[str, Field(alias='subscriptionId')]
    """
    The gateway subscription id of the schedule.
    """
    schedule_status: Annotated[ScheduleStatus, Field(alias='scheduleStatus')]
    """
    The status of the schedule after the change.
    """
    reason: Optional[ScheduleStatusReason] = None
    """
    Why the schedule changed status, where relevant.
    """
    cycle_index: Annotated[Optional[int], Field(alias='cycleIndex', ge=0)] = None
    """
    The cycle concerned, where relevant.
    """
    attempt: Annotated[Optional[int], Field(ge=1)] = None
    """
    The debit attempt concerned, where relevant.
    """
    charge_id: Annotated[Optional[str], Field(alias='chargeId')] = None
    """
    The debit id concerned, where relevant.
    """
    amount: Annotated[Optional[int], Field(ge=0)] = None
    """
    The amount in paise concerned, where relevant.
    """
    error: Optional[Error] = None
    """
    The failure, for failure events.
    """
    id: Annotated[str, Field(min_length=1)]
    """
    Stable id for de-duplication: the same scheduler event always has the same id, so a repeated delivery can be ignored.
    """


class ErrorResponse(BaseModel):
    """
    The body of every error response.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    error: ErrorDetail
    """
    The error.
    """


class SchedulerEventsDelivery(BaseModel):
    """
    A delivery of billing scheduler events to the events webhook.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['scheduler']
    """
    Always `scheduler`: tells this delivery from a gateway one.
    """
    events: Annotated[list[SchedulerWebhookEvent], Field(min_length=1)]
    """
    Billing scheduler events in the order they happened. Each has an `id` to de-duplicate on.
    """


class EventsDelivery(RootModel[Union[GatewayEventsDelivery, SchedulerEventsDelivery]]):
    root: Annotated[
        Union[GatewayEventsDelivery, SchedulerEventsDelivery],
        Field(discriminator='kind'),
    ]
    """
    Anything the service POSTs to the events webhook; switch on `kind`.
    """
