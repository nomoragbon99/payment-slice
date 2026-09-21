# Evidence: a subscription before and after an extension

Two REAL Paystack test-mode payments (300000 kobo = NGN 3,000 each, monthly) were made by the same person, `alice@example.com`, on 21 September 2026. Both had been verified as paid by Paystack but were still only `initiated` in our ledger, because they were made while no tunnel was running. They were then fulfilled through the real application, using both callers of `fulfilTransaction()`:

1. **Payment 1** (`pslice-7aba513…`, Paystack transaction 6581171235): Paystack's own captured, genuinely signed `charge.success` webhook was replayed through the running route (`POST /api/webhooks/paystack`, exact bytes and the real `x-paystack-signature`).
2. **Payment 2** (`pslice-92769fe…`, Paystack transaction 6581187805): alice opened `/checkout/return?reference=…` (the page).
3. **Payment 2's webhook** was then replayed AFTER the page had already fulfilled it, then payment 1's webhook was redelivered, then both were sent again, and a copy of payment 1's body with one byte changed (same signature) was sent.

Payment 2 was created at 16:13:55 UTC, its card was declined 14 seconds later, and the SAME reference was paid at 19:19:36 UTC (about 3 hours later). Both payments were honoured hours after their checkouts started: there is no expiry.

Times below are UTC. All statements were read directly from the database.

## Before

`subscriptions`: no rows.  `webhook_events`: no rows.

| payment | event_type | status | provider id | amount | currency | at |
|---|---|---|---|---|---|---|
| pslice-7aba513… | initiated | pending | | 300000 | NGN | 16:08:41 |
| pslice-92769fe… | initiated | pending | | 300000 | NGN | 16:13:55 |

## After payment 1 (via the webhook)

Alice has an active monthly subscription for ONE month:

| status | interval | current_period_start | current_period_end | last_tx_ref |
|---|---|---|---|---|
| active | monthly | 2026-09-21 20:18:41 | 2026-10-21 20:18:41 | pslice-7aba513… |

## After payment 2 (via the return page): the extension

The period START is kept; the END is moved out by one more calendar month, because a second payment while active is ADDED to the time already paid for:

| status | interval | current_period_start | current_period_end | last_tx_ref | end = start + 2 months |
|---|---|---|---|---|---|
| active | monthly | 2026-09-21 20:18:41 | 2026-11-21 20:18:41 | pslice-92769fe… | true |

## The ledger afterwards (`payment_log`, append-only)

| payment | event_type | status | provider id | amount | currency | at | evidence stored |
|---|---|---|---|---|---|---|---|
| pslice-7aba513… | initiated | pending | | 300000 | NGN | 16:08:41 | our own outgoing request (amount, callback_url, currency, email, reference) |
| pslice-7aba513… | verified | successful | 6581171235 | 300000 | NGN | 20:18:41 | 9 trimmed fields: amount, channel, currency, domain, gateway_response, id, paid_at, reference, status |
| pslice-7aba513… | fulfilled | successful | 6581171235 | 300000 | NGN | 20:18:41 | source |
| pslice-92769fe… | initiated | pending | | 300000 | NGN | 16:13:55 | our own outgoing request |
| pslice-92769fe… | verified | successful | 6581187805 | 300000 | NGN | 20:18:59 | 9 trimmed fields |
| pslice-92769fe… | fulfilled | successful | 6581187805 | 300000 | NGN | 20:18:59 | source |

Each payment has exactly one `verified` and one `fulfilled` row, however many times its webhook was delivered.

## The idempotency ledger (`webhook_events`)

| event | provider id | status | payment | outcome | processed |
|---|---|---|---|---|---|
| charge.success | 6581171235 | success | pslice-7aba513… | fulfilled | 20:18:41 |
| charge.success | 6581187805 | success | pslice-92769fe… | already_fulfilled | 20:19:17 |

Payment 2's webhook arrived AFTER the page, and was recorded as `already_fulfilled`: it changed nothing. After the redeliveries (payment 1 again, both once more) the counts stayed at 15 ledger rows and 2 event rows, and the subscription end stayed at 2026-11-21 20:18:41. The tampered copy was refused with HTTP 401 and wrote nothing.

## What is NOT stored

- No unexpected key exists in any stored evidence (checked against the 9 allowed keys, our own outgoing-request keys and `source`).
- No card-detail field (bin, last4, expiry, bank, brand, authorization code, card type, signature) exists in `payment_log` or `webhook_events`.
- No email address exists in any webhook event. The only email is in OUR OWN outgoing request on the two `initiated` rows.
- The `payment_log` append-only rule still rejects an UPDATE on this real ledger: `payment_log is append-only: UPDATE is not allowed (add a new row instead)`.
