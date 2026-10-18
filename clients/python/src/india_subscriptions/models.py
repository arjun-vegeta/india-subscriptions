# GENERATED FILE - DO NOT EDIT.
# Source: openapi/openapi.json (generated from the TypeScript Zod schemas by `npm run openapi`).
# Regenerate with: clients/python/scripts/generate_models.sh
# tests/test_models_generated.py fails when this file drifts from the spec.
# ruff: noqa
# mypy: ignore-errors

from __future__ import annotations

from enum import Enum
from typing import Annotated, Any, Dict, Literal, Optional, Union
from uuid import UUID

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
    A supported provider: a payment gateway or an app store.
    """

    RAZORPAY = 'razorpay'
    CASHFREE = 'cashfree'
    PAYU = 'payu'
    PHONEPE = 'phonepe'
    PAYTM = 'paytm'
    APP_STORE = 'app_store'
    GOOGLE_PLAY = 'google_play'


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
    `upi` is a UPI Autopay mandate, `card` a card standing instruction, `enach` an eNACH e-mandate on a bank account, `physical_nach` a paper NACH mandate. `netbanking` and `wallet` apply to one-time payments only.
    """

    UPI = 'upi'
    CARD = 'card'
    ENACH = 'enach'
    PHYSICAL_NACH = 'physical_nach'
    NETBANKING = 'netbanking'
    WALLET = 'wallet'


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
    PAYMENT_SUCCEEDED = 'payment.succeeded'
    PAYMENT_FAILED = 'payment.failed'
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
    APPLE_STOREKIT = 'apple_storekit'
    GOOGLE_PLAY_BILLING = 'google_play_billing'


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
    state: Annotated[Optional[str], Field(max_length=60, min_length=2)] = None
    """
    The customer's state or union territory in India (for example "Karnataka"). Needed when a purchase made through Google Play user choice billing is reported to Google.
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
    Authorise or pay with Razorpay Standard Checkout. Carries exactly one of `subscriptionId` and `orderId`.
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
    subscription_id: Annotated[Optional[str], Field(alias='subscriptionId')] = None
    """
    The Razorpay subscription id to authorise (subscriptions).
    """
    order_id: Annotated[Optional[str], Field(alias='orderId')] = None
    """
    The Razorpay order id to pay (one-time payments).
    """
    amount: Annotated[Optional[int], Field(ge=0)] = None
    """
    The order amount in paise (one-time payments).
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
    charge_id: Annotated[Optional[str], Field(alias='chargeId', min_length=1)] = None
    """
    The id the debit that follows this notification must use, for gateways that tie a debit to its notification. When present, pass it as `chargeId` to createCharge and getCharge.
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
    The charge that was refunded. For a refund of a one-time payment, the payment's id.
    """
    payment_id: Annotated[Optional[str], Field(alias='paymentId')] = None
    """
    The one-time payment that was refunded. A refund of a one-time payment sets both `chargeId` and `paymentId` to the payment's id.
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


class ProviderKind(str, Enum):
    """
    `gateway` is a payment gateway, `store` is an app store (Apple App Store, Google Play).
    """

    GATEWAY = 'gateway'
    STORE = 'store'


class Platform(str, Enum):
    """
    The platform a customer buys on: `ios`, `android` or `web`.
    """

    IOS = 'ios'
    ANDROID = 'android'
    WEB = 'web'


class ChannelPolicy(str, Enum):
    """
    Where purchases on a platform may be taken: `store` is the platform's app store only, `user_choice` is the app store with its own choice screen offering a payment gateway, `gateways` is payment gateways only.
    """

    STORE = 'store'
    USER_CHOICE = 'user_choice'
    GATEWAYS = 'gateways'


class SalesChannel(str, Enum):
    """
    The channel a purchase went through: `store` (an app store) or `gateway` (a payment gateway).
    """

    STORE = 'store'
    GATEWAY = 'gateway'


class ProductKind(str, Enum):
    """
    `subscription` is billed again every interval, `one_time` is paid once.
    """

    SUBSCRIPTION = 'subscription'
    ONE_TIME = 'one_time'


class PaymentStatus(str, Enum):
    """
    Normalised status of a one-time payment. The gateway's own status is preserved verbatim in `providerStatus`. `succeeded`, `failed`, `cancelled`, `refunded` and `partially_refunded` follow a payment that was created.
    """

    CREATED = 'created'
    PENDING = 'pending'
    SUCCEEDED = 'succeeded'
    FAILED = 'failed'
    CANCELLED = 'cancelled'
    REFUNDED = 'refunded'
    PARTIALLY_REFUNDED = 'partially_refunded'


class StoreProduct(BaseModel):
    """
    A product as the app store knows it. Only app stores read it; gateways ignore it.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    product_id: Annotated[str, Field(alias='productId', min_length=1)]
    """
    The product id in App Store Connect or Play Console.
    """
    base_plan_id: Annotated[Optional[str], Field(alias='basePlanId', min_length=1)] = (
        None
    )
    """
    Google Play subscriptions: the base plan id.
    """
    offer_id: Annotated[Optional[str], Field(alias='offerId', min_length=1)] = None
    """
    Google Play offer id, or the App Store promotional offer id.
    """
    consumable: Optional[bool] = None
    """
    One-time products: true when the product can be bought again.
    """


class PromotionalOffer(BaseModel):
    """
    A signed promotional offer to apply to the purchase.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    offer_id: Annotated[str, Field(alias='offerId')]
    """
    The promotional offer id.
    """
    key_id: Annotated[str, Field(alias='keyId')]
    """
    The id of the key that signed the offer.
    """
    nonce: UUID
    """
    A one-time UUID for this signature.
    """
    timestamp: int
    """
    When the signature was made, in milliseconds since the Unix epoch.
    """
    signature: str
    """
    The signature, as StoreKit's promotional offer purchase option expects it.
    """


class AppleStoreKitCheckout(BaseModel):
    """
    Purchase through StoreKit on an Apple device.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['apple_storekit']
    """
    Discriminator: start a StoreKit purchase on the device.
    """
    product_id: Annotated[str, Field(alias='productId')]
    """
    The App Store Connect product id to purchase.
    """
    app_account_token: Annotated[UUID, Field(alias='appAccountToken')]
    """
    Pass to StoreKit's purchase option `appAccountToken`; it ties the purchase to this order.
    """
    promotional_offer: Annotated[
        Optional[PromotionalOffer], Field(alias='promotionalOffer')
    ] = None
    """
    A signed promotional offer to apply to the purchase.
    """


class GooglePlayBillingCheckout(BaseModel):
    """
    Purchase through Google Play Billing on an Android device.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: Literal['google_play_billing']
    """
    Discriminator: start a Google Play Billing flow on the device.
    """
    product_kind: Annotated[ProductKind, Field(alias='productKind')]
    """
    Whether the product is a subscription or a one-time product.
    """
    product_id: Annotated[str, Field(alias='productId')]
    """
    The Play Console product id.
    """
    base_plan_id: Annotated[Optional[str], Field(alias='basePlanId')] = None
    """
    Subscriptions: the base plan id.
    """
    offer_id: Annotated[Optional[str], Field(alias='offerId')] = None
    """
    The offer id, where an offer applies.
    """
    obfuscated_account_id: Annotated[
        str, Field(alias='obfuscatedAccountId', max_length=64, min_length=1)
    ]
    """
    Pass to `BillingFlowParams.setObfuscatedAccountId`; it ties the purchase to this order.
    """
    user_choice_billing: Annotated[bool, Field(alias='userChoiceBilling')]
    """
    True: build the `BillingClient` with `enableUserChoiceBilling`, so Google shows its choice screen.
    """


class CreatePaymentInput(BaseModel):
    """
    Everything needed to create a one-time payment.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    reference: Annotated[Optional[str], Field(max_length=60, min_length=1)] = None
    """
    Your own id for this payment. Sent to the gateway where it accepts one, and echoed back on `Payment.reference`.
    """
    amount: Annotated[int, Field(gt=0)]
    """
    Amount to collect, in paise.
    """
    description: Annotated[Optional[str], Field(max_length=250, min_length=1)] = None
    """
    What the payment is for.
    """
    customer: Customer
    """
    The paying customer.
    """
    payment_methods: Annotated[
        Optional[list[PaymentMethod]], Field(alias='paymentMethods', min_length=1)
    ] = None
    """
    Restrict the payment to these payment methods. Omit to allow all the gateway supports.
    """
    return_url: Annotated[Optional[AnyUrl], Field(alias='returnUrl')] = None
    """
    Where the gateway sends the customer after paying.
    """
    expires_at: Annotated[Optional[AwareDatetime], Field(alias='expiresAt')] = None
    """
    Deadline for the customer to pay.
    """
    metadata: Optional[dict[str, str]] = None
    """
    Free-form key/value pairs stored with the payment.
    """
    idempotency_key: Annotated[
        Optional[str], Field(alias='idempotencyKey', max_length=255, min_length=1)
    ] = None
    """
    Makes the create call safe to retry, where the gateway supports idempotency keys.
    """
    store_product: Annotated[Optional[StoreProduct], Field(alias='storeProduct')] = None
    """
    The product in the app store. App stores require it; gateways ignore it.
    """


class VerifyPaymentInput(BaseModel):
    """
    What the HTTP service and the facade accept when verifying the result of a one-time payment.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    result: dict[str, Any]
    """
    The data the provider handed back to the browser or device, untouched.
    """
    expected_payment_id: Annotated[
        Optional[str], Field(alias='expectedPaymentId', min_length=1)
    ] = None
    """
    The payment id (or your reference) that your server stored when it created the payment. When given, a result that verifies but belongs to a different payment is rejected, so a customer cannot replay one payment to unlock another.
    """


class RefundPaymentInput(BaseModel):
    """
    A refund of a one-time payment.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    payment_id: Annotated[str, Field(alias='paymentId', min_length=1)]
    """
    The payment to refund.
    """
    refund_id: Annotated[str, Field(alias='refundId', max_length=40, min_length=1)]
    """
    Your unique id for this refund.
    """
    amount: Annotated[Optional[int], Field(gt=0)] = None
    """
    Amount to refund in paise. Omit to refund the full payment.
    """
    reason: Annotated[Optional[str], Field(max_length=250)] = None
    """
    Why the payment is refunded.
    """


class ExternalTransactionReport(BaseModel):
    """
    A transaction made outside Google Play billing (user choice billing), reported to Google.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    external_transaction_id: Annotated[
        str, Field(alias='externalTransactionId', max_length=128, min_length=1)
    ]
    """
    Your unique id for this transaction.
    """
    external_transaction_token: Annotated[
        Optional[str], Field(alias='externalTransactionToken')
    ] = None
    """
    The token from the device. Needed on the first transaction only.
    """
    initial_external_transaction_id: Annotated[
        Optional[str], Field(alias='initialExternalTransactionId')
    ] = None
    """
    Renewals: the `externalTransactionId` of the first transaction of the subscription.
    """
    product_kind: Annotated[ProductKind, Field(alias='productKind')]
    """
    Whether the transaction is a subscription charge or a one-time purchase.
    """
    amount: Annotated[int, Field(ge=0)]
    """
    Pre-tax amount in paise (0 for a free trial).
    """
    tax_amount: Annotated[int, Field(alias='taxAmount', ge=0)]
    """
    Tax in paise.
    """
    transaction_time: Annotated[AwareDatetime, Field(alias='transactionTime')]
    """
    When the payment was authorised.
    """
    state: Annotated[str, Field(min_length=2)]
    """
    The customer's state, sent as `userTaxAddress.administrativeArea` with region code `IN`.
    """


class ExternalTransactionRefund(BaseModel):
    """
    A refund of an external transaction, reported to Google.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    external_transaction_id: Annotated[
        str, Field(alias='externalTransactionId', min_length=1)
    ]
    """
    The `externalTransactionId` of the transaction that was refunded.
    """
    refund_time: Annotated[AwareDatetime, Field(alias='refundTime')]
    """
    When the refund was made.
    """
    amount: Annotated[Optional[int], Field(ge=0)] = None
    """
    Pre-tax amount refunded, in paise. Omit for a full refund.
    """
    tax_amount: Annotated[Optional[int], Field(alias='taxAmount', ge=0)] = None
    """
    Tax refunded, in paise. Omit for a full refund.
    """


class ExternalTransactionRecord(BaseModel):
    """
    An external transaction as Google holds it.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    external_transaction_id: Annotated[str, Field(alias='externalTransactionId')]
    """
    Your id for the transaction.
    """
    state: str
    """
    The state Google holds the transaction in, verbatim.
    """
    raw: Optional[Any] = None
    """
    The gateway's response, untouched. Absent when the gateway returned no body.
    """


class RouteExclusion(str, Enum):
    """
    Why a gateway was ruled out: `wrong_product_kind` (no one-time payments), `missing_capability` (a `needs` flag it cannot meet), `payment_method_unsupported` (no overlap with the customer's methods), `excluded_by_merchant` (listed in `exclude`), `unhealthy` (circuit breaker open), `above_max_amount` and `below_min_amount` (the merchant's per-gateway amount bounds).
    """

    WRONG_PRODUCT_KIND = 'wrong_product_kind'
    MISSING_CAPABILITY = 'missing_capability'
    PAYMENT_METHOD_UNSUPPORTED = 'payment_method_unsupported'
    EXCLUDED_BY_MERCHANT = 'excluded_by_merchant'
    UNHEALTHY = 'unhealthy'
    ABOVE_MAX_AMOUNT = 'above_max_amount'
    BELOW_MIN_AMOUNT = 'below_min_amount'


class RouteOutcomeKind(str, Enum):
    """
    What an outcome is about: `authorization` (a customer authorising a mandate), `charge` (a recurring debit), `payment` (a one-time payment) or `request` (any other call to the gateway).
    """

    AUTHORIZATION = 'authorization'
    CHARGE = 'charge'
    PAYMENT = 'payment'
    REQUEST = 'request'


class RouteOutcomeResult(str, Enum):
    """
    `success`, `failure` (the gateway answered and the attempt did not succeed, such as a declined card) or `unavailable` (the gateway could not be reached or errored out; this feeds the circuit breaker).
    """

    SUCCESS = 'success'
    FAILURE = 'failure'
    UNAVAILABLE = 'unavailable'


class CircuitState(str, Enum):
    """
    A gateway's circuit breaker: `closed` (normal), `open` (excluded until the cooldown passes) or `half_open` (a candidate again; one `unavailable` result reopens it, one `success` closes it).
    """

    CLOSED = 'closed'
    OPEN = 'open'
    HALF_OPEN = 'half_open'


class RouteNeeds(BaseModel):
    """
    Capabilities the purchase depends on. A flag set to `true` excludes every gateway whose capability of the same name is off; `false` or absent means the capability is not needed.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    trial: Optional[bool] = None
    """
    The gateway must support free trials.
    """
    upfront_amount: Annotated[Optional[bool], Field(alias='upfrontAmount')] = None
    """
    The gateway must be able to collect an upfront amount with the authorisation.
    """
    quantity: Optional[bool] = None
    """
    The gateway must be able to bill several units of a plan.
    """
    pause: Optional[bool] = None
    """
    The gateway must be able to pause a subscription.
    """
    cancel_at_period_end: Annotated[
        Optional[bool], Field(alias='cancelAtPeriodEnd')
    ] = None
    """
    The gateway must be able to cancel a subscription at the end of the paid period.
    """
    change_plan: Annotated[Optional[bool], Field(alias='changePlan')] = None
    """
    The gateway must be able to move a subscription to another plan.
    """
    refunds: Optional[bool] = None
    """
    The gateway must be able to refund charges and payments.
    """


class RouteRequest(BaseModel):
    """
    What is about to be sold, and what the gateway must be able to do for it.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    kind: ProductKind
    """
    Whether the purchase is a subscription or a one-time payment.
    """
    amount: Annotated[int, Field(gt=0)]
    """
    The amount in paise: the amount of every cycle for a subscription, the payment amount for a one-time payment. Checked against the merchant's per-gateway bounds and used to price fees.
    """
    interval: Optional[BillingInterval] = None
    """
    How often a subscription bills. Accepted so a request can describe the whole plan; no gateway capability depends on it today, so it does not change the decision. Ignored for one-time payments.
    """
    payment_methods: Annotated[
        Optional[list[PaymentMethod]], Field(alias='paymentMethods', min_length=1)
    ] = None
    """
    The payment methods the customer can use. A gateway is a candidate only if it offers at least one of them (its mandate methods for a subscription, its one-time methods for a one-time payment). Absent: any method.
    """
    needs: Optional[RouteNeeds] = None
    """
    Capabilities the purchase depends on.
    """
    exclude: Optional[list[Provider]] = None
    """
    Providers that must not be chosen, for example one that just failed this customer.
    """
    prefer: Optional[Provider] = None
    """
    A provider to favour, for example the gateway the customer already has a mandate with. It earns a score bonus but is never chosen if a hard filter excludes it.
    """


class RouteFactors(BaseModel):
    """
    The inputs behind a candidate's score.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    success_rate: Annotated[
        Optional[float], Field(alias='successRate', ge=0.0, le=1.0)
    ] = None
    """
    The success rate used in the score, from 0 to 1: successes over all observations in the window, with missing observations below the minimum sample count filled in with the prior rate.
    """
    samples: Annotated[Optional[int], Field(ge=0)] = None
    """
    How many observations in the window the success rate is based on.
    """
    cost: Annotated[Optional[float], Field(ge=0.0)] = None
    """
    The gateway's estimated fee for this amount, in paise (fractional when it is the mean over several payment methods). Priced from the strategy's `costs`, or its `defaultCost` for a gateway without an entry.
    """
    priority: Annotated[Optional[float], Field(ge=0.0, le=1.0)] = None
    """
    The priority factor from 0 to 1: 1 for the first provider in the merchant's priority list, 0 for one that is not listed.
    """
    healthy: Optional[bool] = None
    """
    `true` when the circuit is closed, `false` when it is half-open and the gateway is on probation.
    """


class RouteCandidate(BaseModel):
    """
    One gateway considered for a request, with the reason it was excluded or the score it earned.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway.
    """
    eligible: bool
    """
    `true` when no hard filter excluded the gateway.
    """
    exclusions: list[RouteExclusion]
    """
    Every hard filter that excluded the gateway; empty when it is eligible.
    """
    details: Optional[list[str]] = None
    """
    A readable sentence for each entry of `exclusions`, in the same order. Absent when the gateway is eligible.
    """
    score: Optional[float] = None
    """
    The score of an eligible gateway; higher is better. Absent when excluded.
    """
    factors: Optional[RouteFactors] = None
    """
    The inputs behind the score. Absent when excluded.
    """


class RoutingDecision(BaseModel):
    """
    The router's answer, with the reasoning behind it.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The best gateway for the request: the first of `ranked`.
    """
    ranked: Annotated[list[Provider], Field(min_length=1)]
    """
    Every eligible gateway, best first. Try them in this order when one fails to create the purchase.
    """
    candidates: list[RouteCandidate]
    """
    Every gateway that was considered: the eligible ones in rank order, then the excluded ones by name.
    """


class RouteOutcome(BaseModel):
    """
    How one attempt at a gateway ended; report it to `Router.record` so routing learns.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway the attempt went to.
    """
    kind: RouteOutcomeKind
    """
    What the attempt was: an authorisation, a charge, a payment or another request.
    """
    result: RouteOutcomeResult
    """
    How it ended: `success`, `failure` or `unavailable`.
    """
    payment_method: Annotated[Optional[PaymentMethod], Field(alias='paymentMethod')] = (
        None
    )
    """
    The payment method used, when known. It is recorded in addition to the gateway-wide figures.
    """
    at: Optional[AwareDatetime] = None
    """
    When the attempt ended. Defaults to the router's clock.
    """


class Weights(BaseModel):
    """
    How much each factor counts. The score is the weighted sum of the factors plus the `prefer` bonus.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    success_rate: Annotated[float, Field(alias='successRate', ge=0.0)]
    """
    Weight of the success rate (0 to 1). Default 1.
    """
    cost: Annotated[float, Field(ge=0.0)]
    """
    Weight of the share of the amount kept after the gateway's fee (0 to 1). Default 1.
    """
    priority: Annotated[float, Field(ge=0.0)]
    """
    Weight of the priority factor (0 to 1). Default 0.02.
    """
    prefer: Annotated[float, Field(ge=0.0)]
    """
    Bonus added to the gateway named in the request's `prefer`. Default 0.05.
    """


class Kinds(BaseModel):
    """
    Which recorded outcome kinds make up the success rate, per product kind.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    subscription: Annotated[list[RouteOutcomeKind], Field(min_length=1)]
    """
    Outcome kinds that count for a subscription. Default: `authorization` and `charge`.
    """
    one_time: Annotated[list[RouteOutcomeKind], Field(min_length=1)]
    """
    Outcome kinds that count for a one-time payment. Default: `payment`.
    """


class SuccessRate(BaseModel):
    """
    How the observed success rate is computed.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    window_hours: Annotated[int, Field(alias='windowHours', gt=0)]
    """
    How many hours of statistics to look at. Statistics are kept in whole UTC hours, so the window is rounded out to the hour. Default 24.
    """
    min_samples: Annotated[int, Field(alias='minSamples', ge=0)]
    """
    Observations needed before the observed rate counts fully. Below it, the missing observations are filled in with `priorRate`. Default 20.
    """
    prior_rate: Annotated[float, Field(alias='priorRate', ge=0.0, le=1.0)]
    """
    The success rate assumed when nothing is known (0 to 1). Default 0.9.
    """
    kinds: Kinds
    """
    Which recorded outcome kinds make up the success rate, per product kind.
    """


class Methods(BaseModel):
    """
    A fee: a percentage of the amount plus a fixed amount.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    percent_bps: Annotated[int, Field(alias='percentBps', ge=0)]
    """
    The percentage part of the fee in basis points of the amount: 200 is 2%.
    """
    fixed_paise: Annotated[int, Field(alias='fixedPaise', ge=0)]
    """
    The fixed part of the fee in paise.
    """


class Costs(BaseModel):
    """
    What a gateway charges the merchant: a fee, optionally different per payment method.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    percent_bps: Annotated[int, Field(alias='percentBps', ge=0)]
    """
    The percentage part of the fee in basis points of the amount: 200 is 2%.
    """
    fixed_paise: Annotated[int, Field(alias='fixedPaise', ge=0)]
    """
    The fixed part of the fee in paise.
    """
    methods: Optional[dict[PaymentMethod, Methods]] = None
    """
    Fees that replace the gateway's own fee for a payment method (UPI is often cheaper than cards).
    """


class DefaultCost(BaseModel):
    """
    The fee assumed for a gateway that has no entry in `costs`. Default: free, so list every gateway once you list any.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    percent_bps: Annotated[int, Field(alias='percentBps', ge=0)]
    """
    The percentage part of the fee in basis points of the amount: 200 is 2%.
    """
    fixed_paise: Annotated[int, Field(alias='fixedPaise', ge=0)]
    """
    The fixed part of the fee in paise.
    """


class Limits(BaseModel):
    """
    The amounts the merchant is willing to route to a gateway. Applies to subscriptions and one-time payments alike.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    min_amount: Annotated[Optional[int], Field(alias='minAmount', gt=0)] = None
    """
    The smallest amount, in paise, the merchant sends to this gateway.
    """
    max_amount: Annotated[Optional[int], Field(alias='maxAmount', gt=0)] = None
    """
    The largest amount, in paise, the merchant sends to this gateway, for example the per-debit ceiling a mandate allows without extra authentication.
    """


class CircuitBreaker(BaseModel):
    """
    When a gateway that keeps being unavailable is taken out of rotation, and when it is let back in.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    failure_threshold: Annotated[int, Field(alias='failureThreshold', gt=0)]
    """
    Consecutive `unavailable` results that open the circuit. Default 5.
    """
    cooldown_ms: Annotated[int, Field(alias='cooldownMs', gt=0)]
    """
    Milliseconds an open circuit waits before it half-opens. Default 60000.
    """


class RoutingStrategy(BaseModel):
    """
    How the router decides: the weights of the score, the merchant's fees, priorities and limits, and the circuit breaker.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    weights: Weights
    """
    How much each factor counts. The score is the weighted sum of the factors plus the `prefer` bonus.
    """
    success_rate: Annotated[SuccessRate, Field(alias='successRate')]
    """
    How the observed success rate is computed.
    """
    costs: dict[Provider, Costs]
    """
    What each gateway charges the merchant. Absent for a gateway means `defaultCost` applies.
    """
    default_cost: Annotated[DefaultCost, Field(alias='defaultCost')]
    """
    The fee assumed for a gateway that has no entry in `costs`. Default: free, so list every gateway once you list any.
    """
    priority: list[Provider]
    """
    Merchant preference order, most preferred first. Also breaks ties between equal scores.
    """
    limits: dict[Provider, Limits]
    """
    Per-gateway bounds on the amount the merchant routes there.
    """
    circuit_breaker: Annotated[CircuitBreaker, Field(alias='circuitBreaker')]
    """
    When a gateway that keeps being unavailable is taken out of rotation, and when it is let back in.
    """


class SessionStatus(str, Enum):
    """
    `open` (the customer has not come back from checkout), `awaiting_payment` (paid or approved but not confirmed yet, or the gateway checkout of a user choice billing purchase is under way), `completed`, `failed` (a verification said not paid; a later payment still completes it) or `expired` (a payment confirmed afterwards still completes it).
    """

    OPEN = 'open'
    AWAITING_PAYMENT = 'awaiting_payment'
    COMPLETED = 'completed'
    FAILED = 'failed'
    EXPIRED = 'expired'


class EntitlementStatus(str, Enum):
    """
    `active`, `trialing` and `past_due` give access; `paused`, `halted`, `cancelled`, `expired` and `refunded` do not. A subscription cancelled at the end of its period stays `active` with `cancelAtPeriodEnd` set until the period ends.
    """

    ACTIVE = 'active'
    TRIALING = 'trialing'
    PAST_DUE = 'past_due'
    PAUSED = 'paused'
    HALTED = 'halted'
    CANCELLED = 'cancelled'
    EXPIRED = 'expired'
    REFUNDED = 'refunded'


class ReportKind(str, Enum):
    """
    `transaction` reports a purchase, a free trial or a renewal to Google; `refund` reports a refund.
    """

    TRANSACTION = 'transaction'
    REFUND = 'refund'


class ReportStatus(str, Enum):
    """
    `queued` (waiting to be sent), `sent` (Google accepted it) or `rejected` (Google refused it as invalid; never retried).
    """

    QUEUED = 'queued'
    SENT = 'sent'
    REJECTED = 'rejected'


class FlushOutcome(str, Enum):
    """
    What a flush did with a report: `sent`, `retrying` (failed, tried again after a backoff), `blocked` (waiting for the report it refers to), `rejected` (invalid, never retried) or `no_reporter` (nothing configured to send with).
    """

    SENT = 'sent'
    RETRYING = 'retrying'
    BLOCKED = 'blocked'
    REJECTED = 'rejected'
    NO_REPORTER = 'no_reporter'


class AttemptOutcome(str, Enum):
    """
    `created` or `failed`.
    """

    CREATED = 'created'
    FAILED = 'failed'


class ProductPlan(BaseModel):
    """
    Extra plan fields passed to a gateway when a subscription of the product is created. The name, amount and interval come from the product.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    description: Annotated[Optional[str], Field(max_length=500)] = None
    """
    Plan description.
    """
    scheduling: Optional[SchedulingMode] = None
    """
    Who raises each charge. Defaults to the gateway's native mode.
    """
    max_amount: Annotated[Optional[int], Field(alias='maxAmount', gt=0)] = None
    """
    Ceiling the mandate allows per debit, in paise. Defaults to the product `amount`.
    """
    max_cycles: Annotated[Optional[int], Field(alias='maxCycles', gt=0)] = None
    """
    Number of cycles after which the plan ends. Omit for open-ended.
    """
    metadata: Optional[dict[str, str]] = None
    """
    Free-form key/value pairs stored with the plan.
    """


class Product(BaseModel):
    """
    A product you sell, with its price and where it lives in each store.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    key: Annotated[str, Field(max_length=60, min_length=1)]
    """
    Your product key. Purchases, sessions and entitlements refer to it.
    """
    kind: ProductKind
    """
    `subscription` or `one_time`.
    """
    name: Annotated[str, Field(max_length=100, min_length=1)]
    """
    Product name, shown to the customer by the gateways.
    """
    amount: Annotated[int, Field(gt=0)]
    """
    Price on gateways in paise, tax included.
    """
    interval: Optional[BillingInterval] = None
    """
    How often a subscription bills. Required for subscriptions.
    """
    trial_days: Annotated[Optional[int], Field(alias='trialDays', gt=0)] = None
    """
    Free trial length in days on gateways (only gateways that support trials are chosen). Stores use their own offers.
    """
    tax_rate_bps: Annotated[Optional[int], Field(alias='taxRateBps', ge=0)] = None
    """
    Tax included in `amount`, in basis points (1800 is 18%). Required for products sold through Google Play user choice billing: reports to Google split the charge into a pre-tax amount and tax.
    """
    physical_goods: Annotated[Optional[bool], Field(alias='physicalGoods')] = None
    """
    True: the product is never sold through app store billing and goes to the gateways on every platform.
    """
    platforms: Annotated[Optional[list[Platform]], Field(min_length=1)] = None
    """
    The platforms the product is sold on. Omit for all of them.
    """
    payment_methods: Annotated[
        Optional[list[PaymentMethod]], Field(alias='paymentMethods', min_length=1)
    ] = None
    """
    Restrict gateway purchases of the product to these payment methods. Only gateways that offer one of them are chosen, and the gateway is told to offer only these. Omit to allow every method the gateway supports.
    """
    app_store: Annotated[Optional[StoreProduct], Field(alias='appStore')] = None
    """
    The product in App Store Connect. Required to sell on iOS.
    """
    google_play: Annotated[Optional[StoreProduct], Field(alias='googlePlay')] = None
    """
    The product in Play Console. Required to sell on Android when the policy is `store` or `user_choice`.
    """
    plan: Optional[ProductPlan] = None
    """
    Extra plan fields for gateway subscriptions, such as `maxAmount`.
    """


class PlatformPolicy(BaseModel):
    """
    Where purchases on each platform may be taken.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    ios: Literal['store']
    """
    iOS: App Store only.
    """
    android: ChannelPolicy
    """
    Android: `store` (Google Play only), `user_choice` (Google Play with its choice screen offering a gateway, reported to Google) or `gateways` (apps distributed outside Google Play).
    """
    web: Literal['gateways']
    """
    Web: payment gateways only.
    """


class PurchaseAttempt(BaseModel):
    """
    One gateway tried while creating the purchase.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The gateway that was tried.
    """
    outcome: AttemptOutcome
    """
    Whether the gateway created the order or mandate.
    """
    at: AwareDatetime
    """
    When the attempt was made.
    """
    error_code: Annotated[Optional[str], Field(alias='errorCode')] = None
    """
    The error code of a failed attempt.
    """
    message: Optional[str] = None
    """
    The error message of a failed attempt.
    """


class EntitlementItem(BaseModel):
    """
    One purchase the customer owns or owned.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    product: str
    """
    The key of the product.
    """
    kind: ProductKind
    """
    `subscription` or `one_time`.
    """
    provider: Provider
    """
    The provider that holds the purchase.
    """
    channel: SalesChannel
    """
    `store` or `gateway`.
    """
    platform: Platform
    """
    The platform the customer bought on.
    """
    subscription_id: Annotated[Optional[str], Field(alias='subscriptionId')] = None
    """
    The provider's subscription id.
    """
    payment_id: Annotated[Optional[str], Field(alias='paymentId')] = None
    """
    The provider's payment id.
    """
    status: EntitlementStatus
    """
    What the customer has.
    """
    active: bool
    """
    True when the item gives access now.
    """
    cancel_at_period_end: Annotated[
        Optional[bool], Field(alias='cancelAtPeriodEnd')
    ] = None
    """
    True when the subscription ends at the end of the current period.
    """
    current_period_end: Annotated[
        Optional[AwareDatetime], Field(alias='currentPeriodEnd')
    ] = None
    """
    End of the current paid period, where known.
    """
    updated_at: Annotated[AwareDatetime, Field(alias='updatedAt')]
    """
    When the item last changed.
    """


class Entitlements(BaseModel):
    """
    What a customer owns, across app stores and gateways.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    customer_ref: Annotated[str, Field(alias='customerRef')]
    """
    Your id for the customer.
    """
    active: bool
    """
    True when at least one item gives access now.
    """
    items: list[EntitlementItem]
    """
    Every purchase of the customer, newest change first, including ended ones.
    """


class StartPurchaseInput(BaseModel):
    """
    Everything needed to start a purchase.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    platform: Platform
    """
    The platform the customer buys on.
    """
    product: Annotated[str, Field(min_length=1)]
    """
    The key of the product.
    """
    customer: Customer
    """
    The paying customer. `state` is required when the platform policy is `user_choice`, because the purchase is then reported to Google.
    """
    customer_ref: Annotated[
        str, Field(alias='customerRef', max_length=128, min_length=1)
    ]
    """
    Your id for the customer: entitlements are kept under it.
    """
    reference: Annotated[
        Optional[str], Field(max_length=25, min_length=1, pattern='^[A-Za-z0-9_-]+$')
    ] = None
    """
    Your own id for the purchase: at most 25 characters of letters, digits, `_` and `-`, the tightest limit among the gateways. Retrying a start with the same reference and customer returns the same session.
    """
    return_url: Annotated[Optional[AnyUrl], Field(alias='returnUrl')] = None
    """
    Where a gateway sends the customer after paying.
    """


class ChooseAlternativeInput(BaseModel):
    """
    The customer's choice of the alternative payment on Google's screen.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    external_transaction_token: Annotated[
        str, Field(alias='externalTransactionToken', min_length=1)
    ]
    """
    The token Google gave the app when the customer chose the alternative on its choice screen.
    """


class CompletePurchaseInput(BaseModel):
    """
    The result of a checkout, to complete a purchase session with.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The provider the customer paid at.
    """
    result: dict[str, Any]
    """
    What the provider handed back to the browser or device, untouched.
    """


class FlushOptions(BaseModel):
    """
    Options for sending queued reports.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    limit: Annotated[Optional[int], Field(ge=1, le=500)] = None
    """
    Most reports to send in this flush. Defaults to 50.
    """


class FlushEntry(BaseModel):
    """
    What a flush did with one report.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    id: str
    """
    The report id.
    """
    kind: ReportKind
    """
    A transaction or a refund.
    """
    outcome: Optional[FlushOutcome] = None
    """
    What the flush did with the report. Absent for an overdue report this flush did not try.
    """
    attempts: Annotated[int, Field(ge=0)]
    """
    Attempts made so far, including this one.
    """
    due_by: Annotated[AwareDatetime, Field(alias='dueBy')]
    """
    When Google must have the report.
    """
    overdue: bool
    """
    True when the report was not sent by `dueBy`.
    """
    error_code: Annotated[Optional[str], Field(alias='errorCode')] = None
    """
    The error code of a failed attempt.
    """
    error_message: Annotated[Optional[str], Field(alias='errorMessage')] = None
    """
    The error message of a failed attempt.
    """


class FlushResult(BaseModel):
    """
    The outcome of sending queued reports to Google.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    sent: Annotated[int, Field(ge=0)]
    """
    Reports Google accepted in this flush.
    """
    retrying: Annotated[int, Field(ge=0)]
    """
    Reports whose attempt failed and that stay queued with a backoff.
    """
    blocked: Annotated[int, Field(ge=0)]
    """
    Reports waiting for an earlier report to be sent.
    """
    rejected: Annotated[int, Field(ge=0)]
    """
    Reports Google refused as invalid. They are not retried.
    """
    skipped: Annotated[int, Field(ge=0)]
    """
    Reports left queued because no reporter is configured.
    """
    entries: list[FlushEntry]
    """
    One entry per report this flush looked at.
    """
    overdue: list[FlushEntry]
    """
    Every queued report past its `dueBy`, whether or not this flush tried it. Page someone when this is not empty.
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
    NO_ROUTE = 'NO_ROUTE'
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


class RoutingReceipt(BaseModel):
    """
    Acknowledgement of an outcome the router recorded.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    recorded: bool
    """
    True when the router counted the outcome.
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
    NO_ROUTE = 'NO_ROUTE'
    INTERNAL_ERROR = 'INTERNAL_ERROR'


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


class CashfreeCheckout(BaseModel):
    """
    Authorise or pay with Cashfree.js: `subscriptionsCheckout` for a subscription, `checkout` for a one-time payment.
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
    The session id to pass to Cashfree.js: the subscription session id or the payment session id.
    """
    environment: Environment
    """
    Which Cashfree environment to initialise Cashfree.js with.
    """
    product_kind: Annotated[Optional[ProductKind], Field(alias='productKind')] = None
    """
    Absent or `subscription`: call Cashfree.js `subscriptionsCheckout`. `one_time`: call Cashfree.js `checkout` with the same `sessionId` as the payment session id.
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
    store_product: Annotated[Optional[StoreProduct], Field(alias='storeProduct')] = None
    """
    The product in the app store. App stores require it; gateways ignore it.
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
                RedirectCheckout,
                FormPostCheckout,
                RazorpayCheckout,
                CashfreeCheckout,
                AppleStoreKitCheckout,
                GooglePlayBillingCheckout,
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
    The provider these capabilities describe.
    """
    kind: ProviderKind
    """
    `gateway` or `store`.
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
    cancel: bool
    """
    A subscription can be cancelled from the server.
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
    one_time_payments: Annotated[bool, Field(alias='oneTimePayments')]
    """
    One-time payments are supported (`createPayment`).
    """
    one_time_payment_methods: Annotated[
        list[PaymentMethod], Field(alias='oneTimePaymentMethods')
    ]
    """
    The payment methods one-time payments can be taken with.
    """


class Payment(BaseModel):
    """
    A one-time payment.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The provider that holds the payment.
    """
    id: str
    """
    The identifier to pass back to this library for every later call.
    """
    reference: Optional[str] = None
    """
    Your own reference, where one was supplied.
    """
    status: PaymentStatus
    """
    Normalised payment status.
    """
    provider_status: Annotated[str, Field(alias='providerStatus')]
    """
    The provider's own status, verbatim.
    """
    amount: Annotated[int, Field(ge=0)]
    """
    Amount of the payment in paise.
    """
    currency: Optional[Currency] = None
    """
    Currency of the payment.
    """
    refunded_amount: Annotated[Optional[int], Field(alias='refundedAmount', ge=0)] = (
        None
    )
    """
    Amount refunded so far, in paise.
    """
    payment_method: Annotated[Optional[PaymentMethod], Field(alias='paymentMethod')] = (
        None
    )
    """
    The payment method the customer paid with.
    """
    customer: Optional[Customer] = None
    """
    The paying customer, where known.
    """
    created_at: Annotated[Optional[AwareDatetime], Field(alias='createdAt')] = None
    """
    When the payment was created.
    """
    paid_at: Annotated[Optional[AwareDatetime], Field(alias='paidAt')] = None
    """
    When the payment succeeded.
    """
    failure_code: Annotated[Optional[str], Field(alias='failureCode')] = None
    """
    The provider's failure code, where the payment failed.
    """
    failure_reason: Annotated[Optional[str], Field(alias='failureReason')] = None
    """
    Human-readable reason the payment failed.
    """
    checkout: Annotated[
        Optional[
            Union[
                RedirectCheckout,
                FormPostCheckout,
                RazorpayCheckout,
                CashfreeCheckout,
                AppleStoreKitCheckout,
                GooglePlayBillingCheckout,
            ]
        ],
        Field(discriminator='kind'),
    ] = None
    """
    Present on freshly created payments: what the customer must do to pay.
    """
    metadata: Optional[dict[str, str]] = None
    """
    Key/value pairs stored with the payment.
    """
    raw: Optional[Any] = None
    """
    The gateway's response, untouched. Absent when the gateway returned no body.
    """


class PaymentVerification(BaseModel):
    """
    The outcome of verifying the result of a one-time payment.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    provider: Provider
    """
    The provider that issued the result.
    """
    payment_id: Annotated[str, Field(alias='paymentId')]
    """
    The payment id to store and use for later calls.
    """
    reference: Optional[str] = None
    """
    Your own reference for the payment, where known.
    """
    paid: bool
    """
    True when the payment succeeded.
    """
    status: Optional[PaymentStatus] = None
    """
    The payment status the result implies, where known.
    """
    payment: Optional[Payment] = None
    """
    The payment, where the verification fetched or carries it.
    """
    raw: Optional[Any] = None
    """
    The verified provider data, untouched. Absent when there is none.
    """


class PurchaseOption(BaseModel):
    """
    One way the customer can pay for the session.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    channel: SalesChannel
    """
    `store` for an app store, `gateway` for a payment gateway.
    """
    provider: Provider
    """
    The provider that holds the purchase.
    """
    checkout: Annotated[
        Union[
            RedirectCheckout,
            FormPostCheckout,
            RazorpayCheckout,
            CashfreeCheckout,
            AppleStoreKitCheckout,
            GooglePlayBillingCheckout,
        ],
        Field(discriminator='kind'),
    ]
    """
    What the browser or device must do to pay.
    """
    handle: str
    """
    The id the provider returned when the purchase was created: the id to expect back from the checkout. For a store it is the account token.
    """
    routing: Optional[RoutingDecision] = None
    """
    Why this gateway was chosen. Present on gateway options.
    """
    hosted_url: Annotated[Optional[AnyUrl], Field(alias='hostedUrl')] = None
    """
    A page that performs this option's checkout step, for a client that cannot run the browser helper (the Android alternative path opens it in a browser tab). Present on gateway options when the service serves a hosted checkout.
    """


class PurchaseSession(BaseModel):
    """
    A purchase in progress or done: where the customer may pay and how it ended.
    """

    model_config = ConfigDict(
        extra='ignore',
        populate_by_name=True,
    )
    id: str
    """
    The session id. Unguessable: whoever holds it can complete the session.
    """
    platform: Platform
    """
    The platform the customer buys on.
    """
    product: str
    """
    The key of the product.
    """
    policy: ChannelPolicy
    """
    The channel policy the session was resolved with: `store`, `user_choice` or `gateways`.
    """
    status: SessionStatus
    """
    Where the session is.
    """
    customer_ref: Annotated[str, Field(alias='customerRef')]
    """
    Your id for the customer.
    """
    reference: Annotated[
        str, Field(max_length=25, min_length=1, pattern='^[A-Za-z0-9_-]+$')
    ]
    """
    Your own id for the purchase: at most 25 characters of letters, digits, `_` and `-`, the tightest limit among the gateways. Retrying a start with the same reference and customer returns the same session.
    """
    return_url: Annotated[Optional[AnyUrl], Field(alias='returnUrl')] = None
    """
    Where the customer is sent when the purchase is done: the `returnUrl` given to `start`.
    """
    options: list[PurchaseOption]
    """
    How the customer can pay. A `user_choice` session has the Google Play option first and the gateway option once the customer chose the alternative.
    """
    attempts: list[PurchaseAttempt]
    """
    Every gateway tried while creating the gateway option, in order.
    """
    external_transaction_token: Annotated[
        Optional[str], Field(alias='externalTransactionToken')
    ] = None
    """
    Set when the customer chose the alternative payment on Google's screen.
    """
    created_at: Annotated[AwareDatetime, Field(alias='createdAt')]
    """
    When the session was created.
    """
    expires_at: Annotated[AwareDatetime, Field(alias='expiresAt')]
    """
    When an unpaid session expires.
    """
    completed_at: Annotated[Optional[AwareDatetime], Field(alias='completedAt')] = None
    """
    When the session completed.
    """
    subscription_id: Annotated[Optional[str], Field(alias='subscriptionId')] = None
    """
    The provider's subscription id, once the purchase is confirmed.
    """
    payment_id: Annotated[Optional[str], Field(alias='paymentId')] = None
    """
    The provider's payment id, once the purchase is confirmed.
    """
    provider: Optional[Provider] = None
    """
    The provider the purchase was confirmed at.
    """


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
    payment_id: Annotated[Optional[str], Field(alias='paymentId')] = None
    """
    The one-time payment the event is about.
    """
    payment: Optional[Payment] = None
    """
    The one-time payment, where the event carries it.
    """
    raw: Optional[Any] = None
    """
    The gateway's webhook payload, untouched. Absent when there is none.
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
