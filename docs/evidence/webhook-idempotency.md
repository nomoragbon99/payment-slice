# Evidence: firing the same webhook twice

A REAL, genuinely-signed Paystack test-mode `charge.success` webhook was replayed twice against the live, running application (`POST /api/webhooks/paystack`) using the exact captured bytes and the original `x-paystack-signature` header — nothing was re-generated or faked. This is the same underlying event Paystack itself already redelivered during the original fulfilment work (see `docs/evidence/subscription-extension.md` and `BUILD_LOG.md`); this file captures it as its own dedicated, saved piece of evidence rather than a narrated aside.

- Source bytes: `tmp/webhook-captures/2026-09-21T16-09-40-002Z.body` (1,325 bytes, captured live from Paystack on 2026-09-21)
- Event: `charge.success`, provider transaction id `6581171235`, reference `pslice-7aba5135-add7-4f1c-a699-40b141e1ca42` (alice's first real payment, already `fulfilled` in `payment_log` since 2026-09-21 20:18:41)
- No new transaction was created for this evidence: the same already-fulfilled event was simply delivered to the live route two more times.

## Before

`webhook_events` already held this event's one row (from its original processing, days earlier):

```json
{
  "id": "e1c0edfe-155f-4a19-9ba3-9fc7bd49ff20",
  "eventType": "charge.success",
  "providerTransactionId": "6581171235",
  "providerStatus": "success",
  "txRef": "pslice-7aba5135-add7-4f1c-a699-40b141e1ca42",
  "receivedAt": "2026-09-21T20:18:41.730Z",
  "processedAt": "2026-09-21T20:18:41.724Z",
  "outcome": "fulfilled"
}
```

Total rows in `webhook_events` at this point: **3** (this one plus the two others from alice's and bob's other real payments).

## Delivery 1: the same signed body, sent again

```
POST /api/webhooks/paystack
x-paystack-signature: ceaba053e823901cb4183449f289c43285be6b3e5b78763db7bca3438f740214a064aca7a1509cfab8656f6018655d6091ab3e2d43ca31e59cc780dd8d8a908d
(the original 1,325-byte body, unmodified)

-> HTTP 200  {"received":true}
```

`webhook_events` after: **the same row**, byte-for-byte — same `id`, same `processed_at` (2026-09-21T20:18:41.724Z, unchanged, days in the past — proving nothing was reprocessed just now). Row count still **3**.

## Delivery 2: fired again immediately after

```
POST /api/webhooks/paystack
(identical request, sent again)

-> HTTP 200  {"received":true}
```

`webhook_events` after: **still the same row**, `id` and `processed_at` both identical to before delivery 1. Row count still **3**.

## What this proves

| | before | after delivery 1 | after delivery 2 |
|---|---|---|---|
| row for this event | 1 (existing) | 1 (same row) | 1 (same row) |
| `processed_at` | 2026-09-21 20:18:41.724 | 2026-09-21 20:18:41.724 | 2026-09-21 20:18:41.724 |
| total `webhook_events` rows | 3 | 3 | 3 |
| `payment_log` rows for this reference | 3 | 3 | 3 |
| alice's `subscriptions.current_period_end` | 2026-11-21 20:18:41.724 | unchanged | unchanged |

Both replayed deliveries answered `HTTP 200 {"received":true}` (Paystack's retry policy requires a 200 to stop retrying, even for an event we choose not to act on again) but wrote nothing: `fulfilTransaction()` found the event's key (`provider`, `eventType`, `providerTransactionId`, `providerStatus`) already present in `webhook_events` and returned `duplicate_event` before ever calling Paystack's verify endpoint or touching `payment_log` or `subscriptions` — this is `webhook_events`'s unique index doing exactly what it is for. Neither the ledger, the idempotency table, nor alice's subscription moved by so much as one row or one millisecond.
