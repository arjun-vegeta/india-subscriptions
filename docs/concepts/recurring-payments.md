# How recurring payments work in India

After this page you will understand the vocabulary every gateway page and error message uses, why a recurring debit in India is not the same as a card-on-file charge elsewhere, which limits you will hit, and why a subscription cannot be moved from one gateway to another.

::: info Where these facts come from
This page summarises what Razorpay's, Cashfree's and PayU's own documentation says about the RBI rules and the payment networks, as read when this library was written. Their pages disagree with each other in places, and the rules change. Treat the numbers as the safe assumptions to build on, and check the current RBI circulars and your gateway's documentation before you rely on an exception.
:::

## The idea: a mandate

In India you cannot simply keep a customer's card number and charge it each month. The customer must give a **mandate**: standing permission, recorded with their bank or card network, for a named merchant to debit their account up to a ceiling on a schedule. The customer gives it once, with strong authentication, and each later debit is then done without them. They can see it and revoke it in their bank or UPI app.

Creating a subscription with this library creates a mandate at the gateway. The customer authorises it in the gateway's checkout. A subscription is "a mandate plus a billing schedule".

## The instruments

| Instrument | What it is | The customer authorises with | Notes |
|---|---|---|---|
| **UPI Autopay** | A recurring mandate on the customer's UPI handle, issued through NPCI (the body that runs UPI). Identified by a UMN. | UPI PIN in their UPI app | Real time. The customer can pause or cancel it in their UPI app. Debits are processed only in off-peak windows. |
| **Card standing instruction** | A recurring-debit permission on a credit or debit card, held as a token by the card network. | OTP or 3-D Secure | Card tokenisation is required. A card mandate ends when the card expires. |
| **eNACH** | An electronic bank-account mandate through NPCI's e-mandate system. Identified by a UMRN. | Net banking, debit card or Aadhaar | The bank registers it afterwards, so it can take 24 to 48 hours (up to T+2) before it is usable. No authorisation amount is taken. Allowed limits are the highest. |
| **Physical NACH** | The paper version of eNACH, with a signed form. | A signed document | Takes 5 to 10 working days. Not supported by this library. |

Not every gateway offers every instrument, and not every instrument works for every plan. The [capability matrix](../reference/generated/capabilities.md) and each [gateway page](../gateways/razorpay.md) say which.

## The pre-debit notification

An RBI rule requires the customer to be told in advance before a recurring debit: the bank or the gateway sends a **pre-debit notification** (usually 24 hours or more before) stating the amount and date, and the customer can opt out. The details differ:

- **Razorpay** and **Cashfree (periodic plans)** send it for you.
- **Cashfree (on-demand plans)** sends it once you raise a charge scheduled at least 48 hours ahead.
- **PayU** requires you to call a pre-debit API 24 to 48 hours before the debit (the library's scheduler uses 48 hours and waits at least 24). eNACH needs none. A debit without a timely notice fails.

If a notification is not sent, the debit fails. This is why the library's [billing scheduler](./scheduling.md) exists: for gateways where you raise the debit, it sends the notice, waits, and only then debits.

## The ₹15,000 threshold and other limits

After the first authorisation, a recurring debit normally needs no further input from the customer. That holds only up to a ceiling:

| Rule | What the gateways say |
|---|---|
| Debits up to **₹15,000** | Processed without the customer doing anything (cards and UPI). |
| Debits above ₹15,000 | The customer must approve each debit with **additional factor authentication (AFA)**: a UPI PIN on the collect request, or an OTP for cards. Gateways often hide card and UPI from checkout for mandates above ₹15,000 unless AFA is enabled on your account. |
| Some categories: mutual funds, insurance premiums, credit-card bill payments | Up to ₹1,00,000 without the customer. |
| eNACH | Much higher limits (₹1,00,00,000 in the gateways' pages) and no per-debit authentication, but only for individual accounts. |
| UPI per-mandate ceiling | ₹15,000 on UPI for PayU's `billingAmount`; Razorpay and Cashfree quote ₹15,000 without AFA and ₹1,00,000 with it. |
| RuPay cards | Razorpay: no initial or later debit above ₹15,000. |
| The amount you charge | Never more than the mandate ceiling. A larger amount needs a new authorisation. |

The ceiling you ask for is the mandate's maximum. Set `maxAmount` on a plan higher than `amount` to leave room for upgrades. Not every gateway honours it: Razorpay has no per-plan ceiling.

Other rules you will meet:

- **Timing.** Gateways cannot debit a mandate on the day it is raised. Cashfree's earliest debit after authorisation is the next day (T+1) before 9 PM and T+2 after, and four days (T+4) for eNACH. UPI debits are processed only before 10:00, between 13:00 and 17:00 and after 21:30.
- **Bank holidays.** eNACH is debited earlier if the date is a bank holiday (Razorpay: the day before, or three days before when two days are holidays).
- **Retries.** Cards and UPI are retried on a short schedule (Razorpay: T+1, T+2, T+3). eNACH and Cashfree's cards are not retried at all; the subscription goes on hold.
- **Authorisation amount.** Authorising a card or UPI mandate needs a small real debit (₹1 to ₹5), which some gateways refund automatically. eNACH takes nothing. See [Trials, delayed starts and upfront amounts](./trials.md).

## Why a mandate stays with the gateway that created it

The mandate lives in the gateway's account with the bank or network: the card token belongs to the gateway as the token requester, the UPI mandate is registered under the gateway's merchant handle, and the eNACH mandate is registered through the gateway's sponsor bank. Only the gateway can debit it, and the gateway cannot export it.

So **you choose the gateway when a subscription starts, not for each renewal**. A UPI Autopay mandate set up through Razorpay can only be debited through Razorpay. To change gateway, the customer authorises a new mandate with the new gateway, and you cancel the old one. This library gives you one API over several gateways; it does not, and cannot, move a mandate between them.

## Terms used in these pages

| Term | Meaning |
|---|---|
| Mandate | The customer's standing permission to debit, up to a ceiling. |
| AFA | Additional factor authentication: the customer approves a debit (a UPI PIN or an OTP). |
| NPCI | The National Payments Corporation of India, which runs UPI and eNACH. |
| UMN, UMRN | The unique ids of a UPI mandate and an eNACH mandate. |
| Pre-debit notification | The advance notice before a recurring debit. |
| Paise | One hundredth of a rupee. All amounts here are integer paise. |
| T, T+1 | The day something happens, and the next day. |
| Consent transaction | PayU's name for the small payment that registers a mandate. |

Next: [The subscription lifecycle](./lifecycle.md).
