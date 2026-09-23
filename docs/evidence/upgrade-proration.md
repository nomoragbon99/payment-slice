# Evidence: a subscription before and after a prorated upgrade

A REAL Paystack test-mode upgrade (Pro monthly -> Pro yearly) was completed by `bob@example.com`, mid-cycle, through the real running application (`POST /api/subscription/upgrade` -> Paystack test-mode checkout -> `/checkout/return`). A screenshot of `/billing` immediately afterwards is saved alongside this file as `billing-after-upgrade.png`.

Times below are UTC. All statements were read directly from the database (`payment_log`, `subscriptions`), read-only, after the fact.

## Before: bob's monthly subscription

Reconstructed from the monthly payment's own `payment_log` rows and the one-calendar-month rule `activateSubscription()` uses (`current_period_start` = the moment it was fulfilled; `current_period_end` = start + 1 calendar month):

| reference | event_type | status | provider id | amount | currency | at |
|---|---|---|---|---|---|---|
| pslice-6c584b1d… | initiated | pending | | 300000 | NGN | 2026-09-21 20:33:38 |
| pslice-6c584b1d… | verified | successful | 6581876937 | 300000 | NGN | 2026-09-21 20:34:20 |
| pslice-6c584b1d… | fulfilled | successful | 6581876937 | 300000 | NGN | 2026-09-21 20:34:20 |

| status | interval | current_period_start | current_period_end | last_tx_ref |
|---|---|---|---|---|
| active | monthly | 2026-09-21 20:34:20.230 | 2026-10-21 20:34:20.230 | pslice-6c584b1d… |

## The upgrade transaction

| reference | event_type | status | provider id | amount | currency | at |
|---|---|---|---|---|---|---|
| pslice-6d04a9f9… | initiated | pending | | 2715766 | NGN | 2026-09-23 10:24:39.086 |
| pslice-6d04a9f9… | verified | successful | 6586568269 | 2715766 | NGN | 2026-09-23 10:24:57.417 |
| pslice-6d04a9f9… | fulfilled | successful | 6586568269 | 2715766 | NGN | 2026-09-23 10:24:57.422 |

All three rows carry `billing_interval = yearly` (the plan being bought). The amount is identical across `initiated`, `verified` and `fulfilled`: Paystack's own verify call echoed back exactly what was asked for, so `evaluateTransaction()` matched cleanly and nothing was flagged as a mismatch.

### The charge matches the proration formula exactly

At the moment the upgrade was initiated (2026-09-23 10:24:39), bob's monthly period (2026-09-21 20:34:20.230 -> 2026-10-21 20:34:20.230, a 30-day period) had been running for:

```
elapsed  = 2026-09-23 10:24:39.086 − 2026-09-21 20:34:20.230
         = 1 day, 13 h, 50 min, 18.856 s
         ≈ 1.5766 days

unused   = 30 − 1.5766 ≈ 28.4234 days
```

Applying `quoteUpgrade()`'s formula (`src/lib/billing/proration.ts`):

```
unused_fraction = 28.4234 / 30           ≈ 0.947447
credit_kobo     = round(0.947447 × 300000) = 284234 kobo   (NGN 2,842.34)
charge_kobo     = 3000000 − 284234        = 2715766 kobo   (NGN 27,157.66)
```

**2,715,766 kobo is exactly the amount recorded on all three `payment_log` rows above.** Bob was credited for the ~28.4 unused days of his monthly period against the yearly price, and charged the remainder — not the full NGN 30,000.

## After: the yearly subscription (current row)

| status | interval | current_period_start | current_period_end | cancel_at_period_end | last_tx_ref |
|---|---|---|---|---|---|
| active | yearly | 2026-09-23 10:24:57.430 | 2027-09-23 10:24:57.430 | false | pslice-6d04a9f9… |

`current_period_start` is the moment the upgrade was fulfilled (*today*), not the old monthly period's start, and `current_period_end` is exactly one calendar year later. The old monthly period's end (2026-10-21 20:34:20.230) does not appear anywhere in the new row: the period was **replaced**, not stacked, which is the behaviour `activateSubscription()`'s interval-change rule is specifically designed to produce (see DECISIONS.md, "Upgrade with proration").

This is the evidence that the ~18.4 remaining unused days of the monthly period were converted into a one-time credit against the charge, rather than being both credited *and* additionally tacked on as extra subscription time -- had the old logic (stack whenever active, regardless of interval) still applied, `current_period_end` would instead read 2027-10-21 20:34:20, a full extra month later than what is actually stored.

## Screenshots

- `billing-after-upgrade.png`: `/billing` as bob, immediately after the upgrade completed, showing the Pro (yearly) plan and its active-until date (the application's own rendering of the "after" state).
- `subscription-after-upgrade.png`: the raw `subscriptions` row itself, via Prisma Studio (`localhost:5557`), taken after the upgrade -- `billing_interval = yearly`, `current_period_start = 2026-09-23`, `current_period_end = 2027-09-23` (the database's own rendering of the "after" state, independent of the application UI). The "before" record is not separately screenshotted: `subscriptions` is a mutable, single-current-row table (see schema.prisma), so once the upgrade was fulfilled the old monthly row was overwritten in place and no longer exists to screenshot. The "before" table above is the honest substitute: it is reconstructed from the monthly payment's own append-only `payment_log` rows, which can never be overwritten, so it is exactly as trustworthy as a screenshot would have been -- just sourced from the ledger instead of the mutable row.

## What is NOT stored

- No card-detail field (bin, last4, expiry, bank, brand, authorization code, card type, signature) exists on either transaction's `payment_log` rows.
- No customer email exists in the provider evidence; the only email is in our own outgoing `initiated`-row request.
- The stored evidence on the `verified` rows still keeps only the same 9 trimmed keys used for every payment (amount, channel, currency, domain, gateway_response, id, paid_at, reference, status).
