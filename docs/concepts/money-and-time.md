# Money and time conventions

After this page you will know how amounts and dates are represented everywhere in the library, and how month ends and time zones are handled, so you never have to guess.

## Money: integer paise

Every amount in the public API, in every language, is an **integer number of paise**. One rupee is 100 paise, so ₹499 is `49900` and ₹1 is `100`. There are no floats, and a non-integer amount is rejected with `VALIDATION`.

Gateways disagree about units: Razorpay uses paise, while Cashfree and PayU use rupees with decimals. The adapters convert at the edge with exact integer arithmetic (never by multiplying or dividing by 100 with floats), so you never see a rupee amount. If you need to display one, use the helpers:

| Helper | Does |
|---|---|
| `paiseToRupeeString(49900)` | `"499.00"` |
| `rupeesToPaise('499.5')` | `49950` |
| `assertPaise(value, 'amount')` | Throws `VALIDATION` unless it is a non-negative integer |

The only currency is INR (`Currency.INR`).

::: info Cashfree amounts
Cashfree's documentation never states the unit of its amounts. The adapter treats them as rupees with decimals, inferred from its examples and the "₹1" minimum.
:::

## Time: ISO-8601 strings

Every instant in the API is an ISO-8601 string with an offset or `Z`: `"2026-11-17T10:30:00+05:30"` or `"2026-11-17T05:00:00.000Z"`. Both mean the same moment, so compare instants by parsing them, not by comparing strings. Inputs accept either form. The scheduler writes UTC strings, which also sort correctly as text.

Never send a local date without an offset. Zod rejects it, and a trial that ends "at midnight" must say in which time zone.

## IST and the calendar

Billing calendar arithmetic is done in **Indian Standard Time**: gateways' dashboards, mandates and customers' bank statements all use IST dates. IST is a fixed UTC+05:30 with no daylight saving, so plain offset arithmetic is exact.

**Month ends.** Cycle `n` is computed from the first charge date every time, not by adding one interval to the previous date. A subscription whose first charge is on 31 December 2026 bills on:

| Cycle | Date |
|---|---|
| 0 | 31 Dec 2026 |
| 1 | 31 Jan 2027 |
| 2 | 28 Feb 2027 |
| 3 | 31 Mar 2027 |
| 4 | 30 Apr 2027 |

Not 31 Jan, 28 Feb, 28 Mar. A leap year gives 29 February. The same rule covers yearly plans started on 29 February and plans every three months. The helper is `cycleStart(anchor, interval, n)`.

**Cycles missed while paused are never billed retroactively.** When a paused schedule resumes, the remaining cycles are re-anchored at the date you give, or now if the pause swallowed the due date.

**Gateways that take a date, not an instant.** Cashfree's charge date and PayU's `debitDate` and mandate start and end are dates. The adapters send the IST calendar date (Cashfree: midnight IST) and the gateway uses only the date part. The scheduler's `debitAtIstTime` policy (`HH:mm` in IST) lets you pick a time of day within that date for the scheduler's own timing, for example to stay inside UPI's off-peak windows.

## Helpers

`toIstIso(date)`, `toIstDateString(date)`, `fromIstDateString('2026-11-17')`, `addDays`, `cycleStart`, `toUnixSeconds`, `unixToIso` and `parseIso` are exported from `india-subscriptions`. `parseIso` rejects impossible dates such as 30 February instead of rolling them over to March.
