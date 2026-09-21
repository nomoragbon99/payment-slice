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

### Payment provider: Flutterwave to Paystack (supersedes the three Flutterwave entries above)
- Decision: which payment provider this slice integrates with.
- Chosen: Paystack, on a new account used by no other project. Decided before any provider-specific integration code existed; only the schema and research were done.
- Rejected and why: staying on Flutterwave. Its webhook URL is set per account, and that account was shared with another live project, so this slice's test webhooks could reach the other project's handler and the other project's live events could reach ours. A dedicated Paystack account removes the collision. Paystack's webhook URL is also set per account, so the same problem would return if this account were ever shared.
- Consequences: the earlier entries "Flutterwave integration: official SDK vs direct REST calls", "Flutterwave API version" and "Webhook authenticity check and encryption key" describe a provider we no longer use and are kept only as history. Paystack sends amounts in kobo already (Flutterwave used major units), which removes one conversion step; amounts are still validated as integers before insert.
- Files: AGENTS.md, .env.example, src/app/layout.tsx, prisma/migrations/20260921050000_provider_neutral_columns/migration.sql

### Paystack integration: official SDK vs direct REST calls
- Decision: how the server talks to Paystack.
- Chosen: call the REST API directly with fetch, no SDK. Endpoints: POST https://api.paystack.co/transaction/initialize (amount in kobo, email, our reference; returns authorization_url to redirect the customer to) and GET /transaction/verify/{reference} (check status, amount, currency and reference before granting anything), with the secret key as a Bearer token.
- Rejected and why: @paystack/paystack-sdk, the official package (Paystack team, PaystackOSS/paystack-node, MIT, ships TypeScript types, no runtime dependencies, no telemetry found, contacts only api.paystack.co). Its newest release, 1.2.1 (published 2026-08-24), is broken: the tarball contains no compiled code and no source (11 files, about 7 KB) while `main` still points at ./dist/index.js. The last working release, 1.2.0 (June 2024), is 1.9 MB across 329 machine-generated files for two calls we need, and it has no webhook signature helper, so the security-critical code is ours either way. Community packages (paystack-sdk, paystack, paystack-node) were rejected as unofficial third parties in a payment path.
- Limits of the research: paystack.com/docs returned HTTP 403 to my fetcher, so the initialize/verify shapes come from Paystack's official OpenAPI spec (PaystackOSS/openapi) and the webhook details from search excerpts of the docs plus two independent guides. To be confirmed against a real test-mode webhook.
- Files: (none yet; applies to the future Paystack client code)

### Webhook authenticity: HMAC-SHA512 (supersedes the Flutterwave verif-hash entry)
- Decision: how to authenticate an incoming webhook.
- Chosen: compute HMAC-SHA512 over the raw request body, keyed with PAYSTACK_SECRET_KEY, hex-encode it and compare in constant time (crypto.timingSafeEqual) with the x-paystack-signature header. The body must be read raw, before any JSON parsing. There is no separate webhook secret, so .env.example has only PAYSTACK_SECRET_KEY. A valid signature is not enough on its own: the transaction is still verified server-to-server before entitlement is granted.
- Safeguard for unrecognised references: the handler never trusts a reference it does not recognise. If data.reference matches no payment_log row of ours, the event is recorded in webhook_events with outcome 'unknown_tx_ref', the handler answers 200 (so Paystack stops retrying) and nothing is fulfilled. This holds even though the account is dedicated.
- Rejected and why: comparing a fixed shared value (Flutterwave's model, which a leaked value defeats and which does not tie the value to the message body); using the signature alone to grant entitlement (our rule is independent verification); a separate PAYSTACK_PUBLIC_KEY (only needed for client-side popups, and our flow redirects to authorization_url from the server).
- Files: .env.example

### Provider-neutral column names plus a provider column
- Decision: how to name the provider's transaction id, and whether to record which provider a row is about.
- Chosen: rename flw_transaction_id to provider_transaction_id on payment_log and webhook_events, and add provider TEXT NOT NULL (CHECK IN ('paystack'), no default, so every insert must say which provider) to both. The uniqueness rules now use (provider, provider_transaction_id): one fulfilment per provider transaction, and webhook key (provider, event_type, provider_transaction_id, provider_status). Migration written by hand with RENAME COLUMN, as a new migration; the applied init migration is untouched.
- Rejected and why: renaming only. An id without its provider is ambiguous, since two providers could issue the same number and the "fulfilled once" index would then block a real payment. Letting Prisma generate the migration: it would DROP COLUMN flw_transaction_id and add a new one, losing any data. Editing the applied migration: breaks its recorded checksum and the append-only migration discipline.
- Files: prisma/schema.prisma, prisma/migrations/20260921050000_provider_neutral_columns/migration.sql

### Sign-in code copied from auth-slice, and what was left out
- Decision: which parts of auth-slice's authentication to bring into this slice (adds detail to the earlier "Reuse of auth-slice's session mechanism" entry).
- Chosen: copy only what identifies a signed-in user, as the assessment brief permits: argon2id password hashing (same OWASP-minimum cost settings), session tokens (32 random bytes in an httpOnly, SameSite=Lax cookie; only the SHA-256 of the token is stored as sessions.id; fixed 7-day lifetime; expired sessions deleted when used), the same-origin CSRF check, the open-redirect guard, the sign-in and sign-out routes with a constant-time dummy hash for unknown emails, the proxy gate plus the real database check in the page, and a minimal dashboard. Session cookie is named payment_slice_session because browsers share localhost cookies across ports and auth-slice already uses auth_slice_session.
- Rejected and why: copying auth-slice's whole auth module (sign-up, email verification, password reset, rate limiting, idempotency keys) because none of it is what this slice is graded on and it would need tables and settings this project does not have.
- Files: src/config/auth.ts, src/lib/auth/*, src/lib/security/origin.ts, src/lib/security/safe-redirect.ts, src/lib/validation/auth.ts, src/lib/db.ts, src/lib/http.ts, src/app/api/auth/signin/route.ts, src/app/api/auth/signout/route.ts, src/proxy.ts, src/app/(auth)/sign-in/*, src/app/dashboard/*

### Sign-in form: plain useState/fetch, not react-hook-form
- Decision: how to build the sign-in form.
- Chosen: one small client component using useState and fetch, validated first by the same Zod schema the server uses, then re-checked by the server.
- Rejected and why: copying auth-slice's react-hook-form form, which brings two more packages (react-hook-form, @hookform/resolvers) and about five helper components for a two-field form that is borrowed infrastructure here.
- Files: src/app/(auth)/sign-in/SignInForm.tsx

### No rate limiting on sign-in
- Decision: whether sign-in gets rate limiting.
- Chosen: none. Sign-in is borrowed infrastructure, the users are seeded test accounts and the app runs in Paystack test mode. Known consequence: unlimited sign-in attempts. Rate limiting will be built where the brief requires it, on checkout initiation, and will need its own store (a new table and migration), planned in that task.
- Rejected and why: copying auth-slice's rate limiter, which needs the rate_limit_buckets table and cleanup settings for something not graded here.
- Files: src/app/api/auth/signin/route.ts (comment marks the omission)

### AUTH_SECRET removed
- Decision: whether this project needs an AUTH_SECRET.
- Chosen: remove it. In auth-slice, AUTH_SECRET only keys the HMAC that protects the emailed 6-digit verification codes; sessions are random 256-bit tokens stored as their SHA-256 and nothing is signed. We do not copy email verification, so the variable would be unused config. The earlier .env.example comment saying it "signs session cookies" was wrong (see BUILD_LOG.md).
- Rejected and why: keeping it "for later" (unused secrets invite confusion); switching sessions to signed cookies (adds a mechanism auth-slice does not use and this slice does not need).
- Files: .env.example, src/lib/auth/tokens.ts

### Seed users with a fixed, committed test password
- Decision: how local test users are created and what their password is.
- Chosen: scripts/seed.ts upserts alice@, bob@ and carol@example.com with one fixed, documented test password, hashed with the same argon2id function as sign-in. It refuses to run unless DATABASE_URL points at localhost or 127.0.0.1, or when NODE_ENV=production. Sign-up is not part of this slice, so seeding is the only way users exist.
- Rejected and why: random passwords printed once (harder to test by hand and for a reviewer to reproduce); a sign-up page (out of scope).
- Files: scripts/seed.ts, package.json (db:seed)

### Checkout initiation: order of operations and failure handling
- Decision: what POST /api/checkout does, in what order, and what happens when Paystack fails.
- Chosen: origin check, signed-in check, rate limit, strict body validation, refuse users with an active subscription (409), check configuration BEFORE writing anything, insert the 'initiated' payment_log row BEFORE calling Paystack (its raw_response is the outgoing request, with no secrets; the customer's email is in it), then call POST /transaction/initialize (10 s timeout). On ANY failure (network error, timeout, 4xx, 5xx, non-JSON, wrong shape, a reference that is not ours, a URL that is not https on paystack.com) the code APPENDS a 'failed' row with the same tx_ref, amount and currency and the failure as jsonb evidence, and answers 502 with a generic message; nothing from Paystack's response is shown to the client. The 'initiated' row is never touched, because payment_log is append-only. If the failed-row write itself fails, the error is logged and the customer still gets the 502. If the initiated-row write fails, Paystack is never called and the route answers 500.
- Rejected and why: calling Paystack first and logging afterwards (if the log write then failed there would be no record of what we expected before the customer could pay); updating the initiated row to failed (forbidden by the append-only rule and blocked by the trigger); showing Paystack's error text to the customer (leaks provider details and may confuse; our own misconfiguration such as a bad key is not the customer's problem).
- Known limits: (1) a timeout is ambiguous: Paystack may have created the transaction anyway, but the customer never receives its URL, so it can never be paid; the log honestly shows initiated then failed. (2) a crash between the two writes leaves an 'initiated' row with no follow-up, which a plain query can list. (3) the 409 only stops users who are already active: two browser tabs can still both start and pay a checkout, so the fulfilment task must decide what a second successful payment means (extend the period, or flag it for refund).
- Files: src/lib/checkout/initiate.ts, src/app/api/checkout/route.ts, src/lib/paystack/client.ts, src/lib/payment-log.ts

### Prices live only on the server, and the request body is strict
- Decision: where the price comes from and what the client may send.
- Chosen: src/config/plans.ts holds the one paid plan ('pro', NGN) with monthly = 300000 kobo (NGN 3,000) and yearly = 3000000 kobo (NGN 30,000), as integers in kobo with the currency beside them. The client sends only billingInterval ('monthly' or 'yearly'); the body is a strict Zod object, so an extra key such as amount or planId gets a 400 instead of being silently ignored.
- Rejected and why: accepting an amount or plan from the client (anyone could pay NGN 1 for Pro by editing the request); a plans table in the database (over-built for one plan, and prices would then be editable data instead of reviewed code).
- Files: src/config/plans.ts, src/lib/validation/checkout.ts

### Rate limiting on checkout: fixed-window table, per user, 5 per 10 minutes
- Decision: how checkout initiation is rate limited (the brief requires it there; sign-in deliberately has none).
- Chosen: a rate_limit_buckets table with primary key (key, window_start) and CHECK count > 0. Each attempt is one atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING count, so concurrent requests cannot both read the same count. Key is checkout:user:<user id>, limit 5 per 10 minutes, checked after the session check and before validation, so every attempt counts, including invalid ones and ones where Paystack later fails. Old buckets are swept opportunistically (at most every 5 minutes per process, failures only logged). Checked with 8 simultaneous requests: exactly 5 allowed and 3 answered 429 with Retry-After, and the stored count was 9 including a follow-up, so no attempt was lost.
- Rejected and why: a per-IP limit (the endpoint already requires sign-in, and IP limits depend on trusting X-Forwarded-For, which anyone can spoof unless a proxy we control sets it); a sliding window (needs timestamps per key; the fixed window needs one row and one statement); an in-memory counter (lost on restart, not shared between processes).
- Known limit: a fixed window lets a client burst up to 2x the limit across a window boundary (5 at the end of one window, 5 at the start of the next).
- Files: prisma/schema.prisma, prisma/migrations/*_add_rate_limit_buckets/migration.sql, src/lib/security/rate-limit.ts, src/config/checkout.ts

### Already-subscribed users get a 409
- Decision: what happens when a user with an active subscription starts a checkout.
- Chosen: 409 ALREADY_SUBSCRIBED when their subscription has status 'active' and current_period_end is in the future; nothing is written and Paystack is not called. 'canceled', 'past_due' and 'active but period over' users may start a checkout.
- Rejected and why: allowing it (an accidental second payment for the same period).
- Files: src/lib/checkout/initiate.ts

### payment_log has one insert path, and the logic takes an injectable database client
- Decision: how application code writes payment_log and how the failure paths are tested.
- Chosen: appendPaymentLog() in src/lib/payment-log.ts is the only place that calls paymentLog.create, and nothing in src calls update or delete on the model (checked with git grep). It and initiateCheckout accept an optional Prisma client, so scripts/check-checkout.ts runs every case (with a fake Paystack) inside a transaction that is rolled back; without that, test rows could never be removed because of the append-only trigger.
- Rejected and why: an ESLint rule forbidding paymentLog.update (a grep check is enough at this size); testing failures by pointing the app at a broken Paystack URL (needs .env edits I must not make, and would leave permanent rows).
- Files: src/lib/payment-log.ts, src/lib/checkout/initiate.ts, scripts/check-checkout.ts

## Deliberately excluded
- Sign-up flow: not in the brief; test users are seeded instead.
- Email verification: not needed to identify a signed-in user in this slice.
- Password reset: not in the brief.
- Rate limiting on sign-in: borrowed infrastructure (see the decision above); rate limiting is built on checkout initiation instead.
- Idempotency-key table from auth-slice: unrelated to the webhook idempotency table this slice needs.
- /api/auth/me endpoint: nothing in this slice calls it.
- Per-IP rate limiting on checkout: the endpoint requires sign-in and IP limits depend on a trusted proxy (see the rate limiting decision).
