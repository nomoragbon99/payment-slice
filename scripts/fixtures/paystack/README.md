# Paystack fixtures

Sanitized copies of real Paystack test-mode payloads, used by the check scripts.

- `charge-success.json`: a `charge.success` webhook body.
- `verify-success.json`: a `GET /transaction/verify/{reference}` response for a paid transaction.

**Same structure, fake values.** Every field name and nesting matches what Paystack really sent (29 fields in
the webhook's `data`, 34 in the verify response's `data`), so tests that must prove sensitive fields are
dropped are testing against realistic input. Every string was replaced by default (email, phone, IP, card
bin/last4/expiry/bank, authorization code, card signature, customer code, names, ids, timestamps); only a
short allow-list of harmless constants (`status`, `channel`, `currency`, `domain`, `event`,
`gateway_response`, `message`) was kept.

They are compact JSON with no trailing newline, so a test can sign their exact bytes.

The **real** captures (with real test-customer details) are never committed: they stay in the gitignored
`tmp/` folder.
