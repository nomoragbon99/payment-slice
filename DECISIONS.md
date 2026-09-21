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

### Rate limiting: exact sliding window replaces the fixed window (supersedes "Rate limiting on checkout: fixed-window table, per user, 5 per 10 minutes")
- Decision: how checkout's limit of 5 attempts per 10 minutes is counted.
- Chosen: an exact sliding window. One row per ALLOWED attempt is stored in rate_limit_attempts(key, at); an attempt is allowed only if fewer than 5 rows for that key are newer than 10 minutes. A per-key advisory lock (pg_advisory_xact_lock) makes the count-then-insert step safe when requests arrive at the same moment. Denied attempts are not stored, so hammering a blocked endpoint never extends the block: it ends exactly when the oldest counted attempt turns 10 minutes old. All timing uses the database clock (clock_timestamp()), so the app server's clock is never involved. The old rate_limit_buckets table is dropped by a NEW migration; the earlier migration that created it is left untouched as history.
- Why (the real test result that exposed the flaw): during the owner's manual browser test, alice got 6 successful checkout requests before the first 429 instead of 5. The database showed one attempt at 12:57:18, inside the fixed window 12:50:00-13:00:00, and five more at 13:03:07-13:03:13 inside the next window 13:00:00-13:10:00; the sixth attempt of that second window made its counter 6 and was blocked. That was correct for a fixed window, which resets on clock boundaries (:00, :10, :20 ...) and so ignored the request made 6 minutes earlier, but it is not what "5 per 10 minutes" says, and in the worst case (5 requests at 12:59:59 and 5 at 13:00:00) 10 requests pass within seconds. Someone testing the limit by sending 6 quick requests could see 6 successes or 5 depending on where the clock happens to fall. I had recorded the 2x burst as a known limit but underestimated how visible it would be.
- Rejected and why: keeping the fixed window (flaky, and visibly not what the requirement says); a weighted two-window approximation (still not exact, and harder to explain line by line); an in-memory counter (per process, lost on restart); SERIALIZABLE transactions with retries (more machinery than one lock for the same guarantee); putting the logic in a Postgres function (harder to read and review than TypeScript for this slice).
- Trade-offs accepted: each attempt is now a short database transaction (lock, count, insert) instead of one upsert; attempts from the SAME user are handled one at a time (other users are unaffected); a database error blocks the request (the limiter fails closed); denied attempts are not recorded in the table.
- Files (planned): prisma/schema.prisma, a new migration, src/lib/security/rate-limit.ts, src/config/checkout.ts, scripts/check-rate-limit.ts

### Sliding window: implementation details
- Decision: choices made while building the sliding-window limiter (follows "Rate limiting: exact sliding window replaces the fixed window").
- Chosen: (1) housekeeping is a DELETE of the same key's expired rows inside each attempt's transaction, replacing the global opportunistic sweep and its settings, so the table holds at most `max` rows per key plus a few stale ones for users who never return; (2) the lock and all statements run in one interactive Prisma transaction with a 5 second limit, so a stalled holder makes waiting requests fail closed instead of hanging; (3) the lock number is hashtextextended(key, 0), a 64-bit hash of the key; (4) the lock is read back through `SELECT 1 FROM (SELECT pg_advisory_xact_lock(...))` because Prisma cannot deserialize the void value the function returns; (5) the test script includes a deliberately lock-free negative control.
- Rejected and why: a global cleanup job (more moving parts for a table this small); a Postgres function for the whole check (harder to read than TypeScript); relying on the concurrency test passing alone without a control (a test that cannot fail proves nothing).
- Evidence: with the lock, 20 trials of 30 simultaneous attempts allowed exactly 5 every time. The same count-then-insert WITHOUT the lock let up to 10-13 through in 20 of 20 trials, with and without an artificial pause, so the test can detect the race.
- Files: src/lib/security/rate-limit.ts, src/config/checkout.ts, scripts/check-rate-limit.ts

### Checkout return page: read-only, honest about what we know
- Decision: what /checkout/return does when Paystack sends a person back after they attempt payment.
- Chosen: the page only REPORTS and never writes to payment_log or subscriptions; arriving from a redirect proves nothing. Order of work: (1) the reference from the query string (reference, falling back to trxref; a repeated parameter counts as none) must match our own format; (2) look up only the signed-in user's own rows for that reference, so someone else's reference is indistinguishable from a nonexistent one; (3) if our ledger has a 'fulfilled' row, show success with no Paystack call and no rate-limit use; (4) otherwise, rate limited, call GET /transaction/verify/{reference}; (5) cross-check reference, amount and currency against what we recorded at initiation; (6) map to a state. States: successful (ledger says fulfilled), activating (Paystack says success and it matches, but no fulfilled row yet; re-checks every 5 s, at most 6 times), processing (any status we do not recognise), not completed (abandoned), failed, reversed, mismatch (paid but reference, amount or currency differ), cannot check (Paystack unreachable or answering nonsense, or our limit reached; says 'unknown', never 'failed'), unknown. All wording is ours; nothing from Paystack's response is shown. The order details shown (plan, amount, reference) come from OUR row, never from Paystack's reply. 'Try again' goes to /dashboard until the subscription screen exists.
- Rate limit: 12 Paystack checks per 10 minutes per user, using the sliding-window limiter, key checkout-return:user:<id>. Reading our own database is not limited. When the limit is hit no Paystack call is made and the page says so honestly.
- Fulfil-on-return is deliberately NOT done here (owner's decision). It moves to the fulfilment task, which will be one shared function, fulfilTransaction(reference), callable from both the webhook and this page. It must prevent double fulfilment in three layers: a per-tx_ref advisory lock (same technique as the rate limiter) so two callers run one after the other; a re-check of the ledger inside the lock so the second caller finds the 'fulfilled' row and does nothing; and the existing partial unique indexes on payment_log as the last backstop, with the subscription write in the same transaction. Note: Paystack cannot reach localhost without a tunnel, so until the page also triggers fulfilment (or a tunnel exists) a paid test payment stays on 'activating' in local development.
- Rejected and why: activating the subscription from this page now (the owner ruled it out for this task, and the decision belongs with the fulfilment design); trusting the redirect's own status parameters (there are none we would trust); showing Paystack's gateway text (its wording is not ours to promise, and could confuse); showing 'failed' when we simply could not reach Paystack (that would tell someone their money failed when we do not know).
- Files: src/lib/checkout/return-status.ts, src/app/checkout/return/page.tsx, src/app/checkout/return/RefreshControls.tsx, src/lib/format-money.ts, src/config/checkout.ts

### What Paystack's verify endpoint really returns (found with real test-mode calls)
- Decision: how the verify client tells 'paid' from 'not paid' from 'unknown reference'.
- Chosen: payment success is data.status === "success" and nothing else. A transaction that exists answers HTTP 200 with the OUTER status:true and message 'Verification successful' even when the customer never paid (data.status is then 'abandoned'), so the outer flag only means the API call worked. An unknown reference answers HTTP 400 (not 404) with code 'transaction_not_found'; the client matches that machine code, not the HTTP status and not the English message. Seen fields: data.id (a number, kept as text), data.status, data.reference, data.amount (integer kobo), data.currency, and many more we ignore. The spec lists statuses success, failed, abandoned and reversed; any other value is treated as 'still processing'.
- Rejected and why: trusting the spec's 404 for a missing reference (real calls returned 400, so a 404 check would never fire and 'not found' would be reported as an outage); matching the message text (English wording can change, the code is the stable contract); treating outer status:true as success (that would call every abandoned checkout paid).
- Files: src/lib/paystack/client.ts

### The payment status page is never cached
- Decision: how to stop a browser or proxy from storing /checkout/return.
- Chosen: Cache-Control: no-store, set for that path in next.config.ts. Verified in a production build (page and its redirect both send it; other pages such as /sign-in are unaffected). Next's dev server ignores it and always sends 'no-cache, must-revalidate' for dynamic pages (the dashboard too), so the header cannot be seen in dev mode.
- Rejected and why: also setting it in proxy.ts (a production build showed the config alone is enough, and two mechanisms for one job need explaining); relying on Next's default for dynamic pages (not guaranteed to be no-store, and this page carries someone's order).
- Files: next.config.ts

### Sign-in keeps the query string
- Decision: what happens when a signed-out person lands on /checkout/return?reference=...
- Chosen: proxy.ts (and the page, for forged or expired cookies) redirects to /sign-in?next=<path and query>, so the reference survives signing in. The sign-in form still only follows a next value that is a path on this site (open-redirect guard, checked with the query-string form and the // form).
- Rejected and why: dropping the query (the reference would be lost and the person would land on 'we can't find that payment' after signing in).
- Files: src/proxy.ts, src/app/checkout/return/page.tsx

### Stored evidence is a trimmed 9-field subset, never Paystack's full payloads
- Decision: what of Paystack's replies and webhooks we keep in our database as dispute evidence.
- Finding that forced this: the two real test-mode webhooks and a real verify response each carry, besides the transaction, the customer's email, phone and customer code, and a whole `authorization` object: card `bin`, `last4`, expiry month and year, `bank`, `brand`, `country_code`, a card `signature`, and an `authorization_code` with `reusable: true`. A reusable authorization code is a token that can be used to charge that card AGAIN later. Storing it would put us in breach of the brief's rule that card details are not stored, and would turn our database into something worth stealing. My earlier design said webhook_events.payload would be "a jsonb copy of the received body"; that is withdrawn.
- Chosen: one zod schema, src/lib/paystack/evidence.ts, keeps exactly id, status, reference, amount (integer kobo), currency, paid_at, channel, gateway_response and domain (about 230 bytes). Zod strips every key that is not listed, so it holds BY CONSTRUCTION: a new sensitive field that Paystack adds later is dropped automatically, with nobody having to remember to remove it. The same schema parses the verify response and the webhook's `data`, and its output is what goes into payment_log.raw_response and webhook_events.payload. The verify client's failure results carry a reason but never the response body (a reply that failed our shape check could still be a full transaction with card details). The `initiated` row's evidence is our own outgoing request, which holds the customer's email but no card data (approved earlier).
- Rejected and why: storing the full body (breaks the brief and stores a reusable card token); a denylist that removes known sensitive fields (misses any field Paystack adds, and fails silently); hashing or encrypting the card object (we would still be keeping card data and the key); keeping nothing (a dispute needs to show which transaction, amount, currency, time and channel).
- Tested: with the sanitized fixtures, none of the sensitive values or key names survives; adding 50 unknown and card-like fields to a payload still leaves exactly the 9 keys. Committed fixtures (scripts/fixtures/paystack/) have the real structure but fake values, produced with a default-deny sanitiser and checked so no real string remains; the real captures stay in the gitignored tmp/ folder.
- Files: src/lib/paystack/evidence.ts, src/lib/paystack/client.ts, prisma/schema.prisma (comments only, no migration), scripts/check-paystack.ts, scripts/fixtures/paystack/

### No expiry on initiated references: a payment hours later is still honoured
- Decision: how old an initiated reference may be and still be fulfilled when Paystack says it is paid.
- Chosen: no limit. If Paystack reports a reference as paid, and reference, amount and currency match what we recorded, we honour it however long ago it was created. Evidence from the real test: reference pslice-92769fe… was created at 16:13:59 UTC, the card was DECLINED 14 seconds in, and the same reference was PAID at 19:19:36 UTC, 11,134 seconds (about 3 hours 5 minutes) after the first attempt, and Paystack sent its charge.success webhook at 19:19:37. So "failed" and "abandoned" are not final (a declined card can be retried, an open payment page can be paid much later), and nothing may be written to the ledger for them; the only terminal positive is status "success".
- Also observed: an abandoned checkout (payment page closed with nothing selected) produced NO webhook and no redirect back to us. Paystack's verify call reported it as "abandoned" with an empty attempt log. So abandoned and declined are learnable only through the verify call (return page, or a later visit), never through a webhook; such a reference simply stays 'initiated'.
- Rejected and why: expiring references after some minutes or hours (someone who really paid would lose their subscription, and money would have moved with nothing to show for it); treating a first failure as final (the same reference later succeeded).
- Files: (applies to the fulfilment function and the webhook handler)

### Real webhook captured: what it confirmed (supersedes the PROVISIONAL note on the idempotency key)
- Decision: whether the webhook design assumptions hold against real Paystack traffic.
- Chosen: they hold, so the schema and the idempotency key stay exactly as they are (no migration). Two real charge.success deliveries were captured through the gate and ngrok. Confirmed: top-level keys are only `event` and `data`; `event` is "charge.success"; there is no separate event id (data.id is the TRANSACTION id, a number, equal to the id the verify call reports); data.status is "success" (not "successful"); data.amount is integer kobo (300000) with data.currency "NGN"; the x-paystack-signature header is 128 lowercase hex characters and equals HMAC-SHA512 of the RAW body bytes keyed with the secret key (recomputed independently for both captures; an HMAC-SHA256 does not match). So the key (provider, event_type, provider_transaction_id, provider_status) = (paystack, charge.success, data.id, success) works. Delivery took about a second after payment. Deliveries came from two different Paystack addresses (52.49.x and 52.31.x), so an IP allowlist would need Paystack's full published list; the signature stays the control. Three independent sources agree that exactly 2 webhooks were sent for 4 payment attempts (2 successes, 1 decline, 1 abandonment): the capture route, the gate's log, and ngrok's own request history.
- Rejected and why: re-serialising the parsed JSON to check the signature (it happened to match here only because Paystack's JSON is compact; the raw bytes are what is signed).
- Files: prisma/schema.prisma (comment updated)

### fulfilTransaction: the one place a payment becomes a subscription (supersedes "read-only page, fulfil-on-return deferred")
- Decision: how a payment turns into a subscription, and who is allowed to trigger it.
- Chosen: one shared function, fulfilTransaction(reference, source), used by BOTH the Paystack webhook and the /checkout/return page (the owner approved fulfil-on-return). Neither caller decides anything: a redirect or a webhook body only NAMES a reference. Order of work: (1) the reference must look like ours and match one of OUR 'initiated' rows (for the page: the signed-in person's own); (2) if our ledger already has a 'fulfilled' row, stop (no Paystack call); (3) ALWAYS ask Paystack (GET verify, server to server, our secret key), outside any database lock; (4) evaluate.ts, the one shared rule: only status exactly "success" with the reference, amount and currency we recorded counts; (5) only then, in ONE database transaction under a per-reference advisory lock: re-check the ledger, write the 'verified' and 'fulfilled' rows, activate the subscription and, for a webhook, record the event. If any write fails, all of it rolls back and the caller is told to retry. This satisfies AGENTS.md's rule that entitlement follows independent server-side verification, never the redirect or the webhook alone.
- Safe when both callers arrive together, in either order, in three layers: the advisory lock (same technique as the rate limiter) makes them run one after the other; the re-check inside the lock makes the second a no-op; and the partial unique indexes on payment_log (one 'fulfilled' per tx_ref and per provider transaction id) are the last backstop. Measured: with the lock and the re-check switched OFF, all 20 racing callers reached the fulfilled insert in every one of 10 trials and the unique index stopped the 19 losers (their whole transactions rolled back); with them ON, exactly one caller ever reaches it.
- What is written: paid and matching -> 'verified' + 'fulfilled' rows and the subscription. Paid but reference, amount or currency differ -> one 'failed' row (once, however many visits or redeliveries), nothing activated. Not paid (abandoned, failed, reversed, unrecognised status) -> NOTHING: these are not final; a real test showed a card declined and the SAME reference paid three hours later. A webhook that Paystack's own verify contradicts is recorded in webhook_events as verification_failed (once). A transient problem (Paystack unreachable, erroring or answering nonsense) writes nothing and is retried.
- Rejected and why: activating from the page alone or from the webhook body (both are unauthenticated claims; the verify call is the authority); calling Paystack inside the database transaction (a network call would hold a lock and a connection); writing rows for every attempt or status (abandoned and failed can still become paid, and repeated visits would flood the append-only ledger).
- Files: src/lib/checkout/fulfil.ts, src/lib/checkout/evaluate.ts, src/lib/checkout/order.ts, src/lib/checkout/return-status.ts

### Subscription rules applied at fulfilment
- Decision: exactly what a successful payment does to the subscription row.
- Chosen: no current subscription (none, expired, canceled or past_due): a new period starts now and lasts one calendar month (monthly) or one calendar year (yearly), cancel_at_period_end is cleared and any cancellation reason removed. Already active with time left (a second payment, for example two browser tabs both paid): the new period is ADDED to the current end (start kept), because the customer paid and must get the time; two fulfilled rows record both payments. Dates are computed in SQL from ONE reading of the database clock; Postgres clamps month ends (31 January + 1 month = 28 February, 29 February 2028 + 1 year = 28 February 2029), both tested. Entitlement remains: status = 'active' AND current_period_end > now(); nothing needs a job to flip status when a period ends.
- Rejected and why: refusing or refunding a second payment (money would be taken with nothing to show, and refunds are out of scope); restarting the period on a second payment (the customer would lose time already paid for); computing dates in JavaScript (month-end overflow: 31 January + 1 month would become 3 March).
- Files: src/lib/checkout/fulfil.ts

### The webhook handler: POST /api/webhooks/paystack
- Decision: how Paystack's webhook is authenticated, parsed and answered.
- Chosen: no session and no same-origin check (server to server). Order: size (at most 64 KB, read as a stream so a huge body is never buffered) -> our secret key configured (else 500) -> signature -> parse -> handle. The signature is HMAC-SHA512 of the RAW body bytes keyed with the secret key, compared in constant time with the x-paystack-signature header, BEFORE anything is parsed, so nothing unauthenticated is ever acted on and formatting changes cannot break it (a pretty-printed CRLF body signed as-is is accepted; one appended newline after signing is refused). Confirmed with Paystack's two real deliveries and with three known-answer vectors computed by openssl. Only charge.success is handled; other event types get 200 and are not stored. It hands the REFERENCE to fulfilTransaction; the body's own words about what happened are never used. Answers: 413 too large; 500 key missing; 401 bad or missing signature (no parsing, no database, no Paystack call); 400 signed but malformed; 200 for everything handled (fulfilled, already fulfilled, duplicate delivery, mismatch, not paid according to Paystack, or a reference we never issued, each recorded once); 503 for anything that could not be finished (Paystack unreachable or erroring, our write failed and rolled back, Paystack has no such transaction yet, any unexpected exception), with Retry-After and nothing half-done, so the retry is safe. Bodies are tiny and generic; nothing is echoed. Processing is synchronous: a lost event is worse than a slow answer, and Paystack's retries are harmless because everything is idempotent. Stored evidence is the trimmed 9-field subset, never the full body.
- Rejected and why: parsing before verifying the signature; answering 200 immediately and processing afterwards (a crash would lose the event with no retry); returning 200 when our own write failed (Paystack would not retry and the customer would never be activated); an IP allowlist (two different Paystack addresses were seen, it needs their full published list, and the signature already authenticates); storing the body (see the evidence entry).
- Files: src/lib/paystack/webhook.ts, src/lib/paystack/webhook-handler.ts, src/app/api/webhooks/paystack/route.ts

### Tests use a temporary copy of the database structure
- Decision: how to test code whose rows can never be deleted and whose value is in concurrency.
- Chosen: scripts/lib/isolated-schema.ts creates a temporary Postgres schema, runs the project's REAL migrations into it (real tables, CHECKs, partial unique indexes and the append-only trigger), gives the test a client whose queries all land there, and always drops it. The fulfilment, webhook and return-page checks use it with real committed rows and real concurrency, and compare the real tables' row counts before and after. Rolled-back transactions remain in use where no concurrency is needed (checkout initiation).
- The safety guard exists because of a near miss: the first version set only the adapter's `schema` option, which makes Prisma's MODEL queries use the temporary schema but leaves RAW SQL (the subscription upsert, the script's own queries) on the real public tables. It failed harmlessly only by luck (a foreign-key error, because the throwaway user existed only in the temporary schema). Now both `schema` and a `search_path` connection option are set, and before any test runs the script checks that current_schema, the resolved subscriptions and payment_log tables and the model queries all land in the temporary schema, and stops otherwise.
- Rejected and why: a second database (not defined in this repo's docker-compose); deleting test rows or disabling the trigger (forbidden: the ledger is append-only); leaving test rows in the real ledger.
- Files: scripts/lib/isolated-schema.ts, scripts/check-fulfilment.ts, scripts/check-webhook.ts, scripts/check-checkout-return.ts

### A gate in front of the tunnel
- Decision: what a public tunnel is allowed to reach.
- Chosen: npm run dev:webhook-gate (127.0.0.1:3991) forwards exactly POST /api/webhooks/paystack to the app and answers 404 to everything else without contacting the app; ngrok points at the gate (ngrok http 3991), never at the app (3002). Tested with 17 refused variants (other routes, wrong methods, trailing slash, query string, double slash, ../, %2e%2e, other case, absolute URL), a 413 for oversized bodies, byte-exact signed pass-through and a 502 when the app is down.
- Why: an ngrok agent forwarding the whole app (ngrok http 3002) was found running on this machine; that publishes sign-in and checkout, with seeded test accounts whose password is in the repo.
- Files: scripts/webhook-gate.ts

## Deliberately excluded
- Sign-up flow: not in the brief; test users are seeded instead.
- Email verification: not needed to identify a signed-in user in this slice.
- Password reset: not in the brief.
- Rate limiting on sign-in: borrowed infrastructure (see the decision above); rate limiting is built on checkout initiation instead.
- Idempotency-key table from auth-slice: unrelated to the webhook idempotency table this slice needs.
- /api/auth/me endpoint: nothing in this slice calls it.
- Per-IP rate limiting on checkout: the endpoint requires sign-in and IP limits depend on a trusted proxy (see the rate limiting decision).
- Refunds, disputes, renewals, cancellations and every webhook event other than charge.success: not in the brief; such events get 200 and are not stored.
- IP allowlisting of Paystack's webhook sources: the signature authenticates, and the address list would have to be kept current.
- A background job to reconcile abandoned references: an abandoned or declined checkout sends no webhook and no redirect; it stays 'initiated' until someone visits its return URL, which is acceptable at this scale.
