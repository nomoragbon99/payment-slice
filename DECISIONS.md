# Decisions

## Decisions

### Repository layout
- Decision: whether payment-slice is its own repository or a folder inside the parent repo at C:\Users\HP\Documents\build-assessments.
- Chosen: standalone repository at payment-slice/, initialised with its own .git, default branch main.
- Rejected and why: committing into the parent repo — rejected because the assessment should be reviewable on its own, same as auth-slice. The parent repo is left untouched.
- Files: .git/, .gitignore

### Reuse of auth-slice's session mechanism
- Decision: how this slice identifies the signed-in user.
- Chosen: reuse auth-slice's session/authentication mechanism. The assessment brief permits this; it will be documented as such in DOCUMENTATION.md.
- Rejected and why: building a second, separate authentication system — out of scope for this slice and would duplicate work the brief lets us reuse.
- Files: (to be filled in when implemented)

### Flutterwave integration: official SDK vs direct REST calls
- Decision: how the server talks to Flutterwave.
- Chosen: call the Flutterwave v3 REST API directly with fetch, no SDK. Endpoints: POST /v3/payments (hosted checkout), GET /v3/transactions/verify_by_reference (server-side verification), all with the secret key as a Bearer token.
- Rejected and why: flutterwave-node-v3 1.4.1 (official, published 2026-06-17). Its source has no call to POST /v3/payments (no hosted checkout) and no webhook verification, so it covers only one of the three needs; it has no TypeScript types; it pulls in axios, winston, joi, q, md5 and node-forge; and since 1.4.0 it sends telemetry (transaction reference, amount, currency) to a third-party monitoring service. The older flutterwave-node was last published in 2023.
- Files: (none yet; applies to the future src/lib/flutterwave code)

### Flutterwave API version
- Decision: which Flutterwave API generation to target.
- Chosen: v3 (secret key + public key + webhook secret hash).
- Rejected and why: v4, which uses different credentials (OAuth client id and secret). Not investigated in depth; v3 is what the documented hosted checkout, verification and `verif-hash` webhook flow use.
- Files: .env.example

### Webhook authenticity check and encryption key
- Decision: how to authenticate webhooks, and whether an encryption key is needed.
- Chosen: compare the `verif-hash` header to FLUTTERWAVE_WEBHOOK_SECRET_HASH (a shared secret, not an HMAC signature, per Flutterwave's v3 docs), then still re-verify the transaction with the API before granting anything. No encryption key variable: in the SDK source it is used only to encrypt card data for direct charges, which this slice does not do.
- Rejected and why: trusting the header alone (a shared secret can leak, and our rule is that entitlement follows independent verification); adding FLUTTERWAVE_ENCRYPTION_KEY "just in case" (unused config invites confusion).
- Files: .env.example

### Local ports
- Decision: host ports for this project so it never collides with other local projects.
- Chosen: app 3002, Postgres 5434, Prisma Studio 5557. Studio is pinned in the db:studio script because an unpinned Studio picks a random port. 5555 is auth-slice's Studio and 5556 is used by another local project.
- Rejected and why: default ports 3000/5432/5555 (already used by other projects on this machine).
- Files: package.json, docker-compose.yml, .env.example

### Scaffold written by hand, not create-next-app
- Decision: how to create the Next.js project.
- Chosen: write the config files by hand, mirroring auth-slice's versions and settings (Next 16.3.5, React 19.2.8, Prisma 7.10.0, Zod 4, Tailwind 4, TypeScript strict), including next.config.ts `agentRules: false` so `next dev` never rewrites AGENTS.md.
- Rejected and why: create-next-app, because it requires an empty folder and this one already holds git history and project docs; it also would not pin the same versions as auth-slice.
- Files: package.json, tsconfig.json, eslint.config.mjs, next.config.ts, postcss.config.mjs, prisma.config.ts

### Free plan: "no subscription row" means free
- Decision: whether free users get a row in subscriptions.
- Chosen: no row = free. A row always describes a paid (pro) period, so every column (plan, interval, period start/end, last_tx_ref) is NOT NULL and plan_id is CHECK = 'pro'. Entitlement is: status = 'active' AND current_period_end > now().
- Rejected and why: a row per user with plan 'free'. It forces the interval, period and payment-reference columns to be nullable, so each NOT NULL is replaced by a CHECK that pairs the columns, and sign-up would have to create the row (a missed insert becomes a new bug). The owner's request that billing_interval only be meaningful for 'pro' is met a simpler way: only 'pro' rows can exist.
- Files: prisma/schema.prisma, prisma/migrations/20260921033354_init_payment_core/migration.sql

### Enum-like columns: text + CHECK, not Prisma enums
- Decision: how to restrict status, event type, interval and similar columns to fixed values.
- Chosen: text columns with CHECK constraints in hand-edited migration SQL (same as auth-slice).
- Rejected and why: Prisma/Postgres enum types, which are awkward to change later (removing or renaming a value is not a simple ALTER).
- Files: prisma/schema.prisma, prisma/migrations/20260921033354_init_payment_core/migration.sql

### Money columns: Int (kobo) with currency, none on subscriptions
- Decision: column type for amounts, and where amounts live.
- Chosen: payment_log.amount is a 4-byte integer in kobo with CHECK amount > 0, and currency NOT NULL with CHECK ~ '^[A-Z]{3}$'. subscriptions has no money columns; the price comes from plan config in code and what was paid lives only in payment_log.
- Rejected and why: BigInt (removes the ~NGN 21.4M cap but forces bigint handling through all TypeScript for no real benefit at subscription prices); decimal/numeric (forbidden by the money rules); a price snapshot on subscriptions (a second copy of the amount that can disagree with the log).
- Note found while testing: Postgres silently ROUNDS a fractional value inserted into an integer column (12.5 is stored as 13). The database therefore cannot reject a decimal amount; the app must validate amounts as integers (Zod) before insert, and convert Flutterwave's major-unit amounts to kobo in exactly one place.
- Files: prisma/schema.prisma

### payment_log is append-only via a database trigger
- Decision: how to make payment_log insert-only.
- Chosen: a BEFORE UPDATE OR DELETE OR TRUNCATE ... FOR EACH STATEMENT trigger that raises an exception (payment_log_reject_mutation), plus a plain FK ON DELETE RESTRICT from payment_log to users. Prisma Client still generates update/delete for the model, so the trigger is what stops them. FOR EACH STATEMENT so zero-row statements and TRUNCATE (which row-level triggers never see) are rejected too. The application code should also expose only an append function.
- Rejected and why: relying on convention alone (nothing stops a future bug); revoking privileges from the app's database role (dev uses the table owner, so the revoke would not bind it). Limit: the table owner can still drop the trigger; this guards against bugs, not a deliberate DBA.
- Files: prisma/migrations/20260921033354_init_payment_core/migration.sql, prisma/migrations/20260921034500_payment_log_trigger_error_code/migration.sql

### Trigger error code
- Decision: which SQLSTATE the append-only trigger raises.
- Chosen: the default raise_exception (P0001), so Prisma shows the real message.
- Rejected and why: restrict_violation (23001), which Prisma reports as "Foreign key constraint violated" and so misleads whoever hits it. Fixed in a second migration because the first was already applied.
- Files: prisma/migrations/20260921034500_payment_log_trigger_error_code/migration.sql

### One fulfilment per transaction, enforced in the database
- Decision: how to guarantee a payment cannot grant entitlement twice.
- Chosen: two partial unique indexes on payment_log, one on tx_ref and one on flw_transaction_id, each WHERE event_type = 'fulfilled'. This covers the return-URL path as well as webhooks, because only webhooks touch webhook_events.
- Rejected and why: a plain UNIQUE on tx_ref (it legitimately repeats once per lifecycle event); relying on webhook_events alone (does not cover the redirect path).
- Files: prisma/migrations/20260921033354_init_payment_core/migration.sql

### Webhook idempotency key (PROVISIONAL)
- Decision: what uniquely identifies a webhook event.
- Chosen: UNIQUE (event_type, flw_transaction_id, provider_status). Flutterwave v3 payloads have no event id; the docs' sample has only `event` and data.id / tx_ref / status / amount / currency. Status is in the key so a genuine status change for one transaction (e.g. pending then successful) is not dropped as a replay. The handler must claim by INSERT (ON CONFLICT DO NOTHING) inside the same transaction as the fulfilment: tested with two real concurrent sessions, the second insert blocks until the first commits (then inserts nothing) or rolls back (then inserts).
- Rejected and why: SELECT-then-INSERT (two concurrent requests can both pass the check); event_type + transaction id only (could swallow a later status update).
- Still to do: confirm against a real test-mode webhook payload before relying on it. If the real payload differs, change it in a new migration.
- Files: prisma/schema.prisma, prisma/migrations/20260921033354_init_payment_core/migration.sql

### users and sessions reused from auth-slice
- Decision: how this slice identifies the signed-in user (updates the earlier "Reuse of auth-slice's session mechanism" entry).
- Chosen: this project's own database holds copies of auth-slice's users and sessions table shape, with the same session mechanism (random token in an httpOnly cookie, only its SHA-256 stored as sessions.id, fixed 7-day lifetime). Permitted by the assessment brief. Sign-in code will be copied and test users seeded; sign-up is not copied. Dropped from auth-slice: email verification, password reset, rate limits, idempotency keys, users.email_verified_at.
- Rejected and why: pointing at auth-slice's database (couples two projects that must stay separate); copying the whole auth-slice schema (unneeded tables, out of scope).
- Files: prisma/schema.prisma

## Deliberately excluded
(none yet)
