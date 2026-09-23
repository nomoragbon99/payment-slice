# payment-slice: Documentation

## 1. What This Is

This is a single subscription-and-payment slice: a signed-in person can choose a Pro plan (monthly or yearly), pay for it through Paystack in test mode, and have their access granted automatically once that payment is independently confirmed. The plan's price comes from the server, never the browser. A payment only ever grants access after the application calls Paystack itself, server-to-server, with a secret key, to ask "was this actually paid?" -- it never trusts a redirect URL, a query string, or a webhook's own say-so. Two independent paths lead to the same fulfilment logic: Paystack's webhook (`charge.success`) and the page the customer lands on after paying, so a payment is honoured whichever one arrives first, and a repeat delivery of either never grants or logs anything twice. Every step of a payment's life -- initiated, verified, fulfilled, or failed -- is written as its own row in an append-only ledger (`payment_log`), so the full history of any transaction, and any mismatch or replay, is always reconstructable after the fact. A subscriber can cancel (access is kept until the period they already paid for ends, not cut off immediately) and undo that before the period ends, and can upgrade from monthly to yearly mid-cycle, paying only the prorated difference for the unused time left on the current plan rather than the full yearly price. There is no subscription "status" that a background job has to keep up to date: whether someone currently has access is worked out fresh, on every request, from the price they were billed and the dates on record.

Deliberately left out, and why: sign-up (test users are seeded directly, since the brief does not ask for account creation), email verification and password reset (neither is needed to identify a signed-in person for this slice), rate limiting on sign-in (the session mechanism is reused as-is from auth-slice; rate limiting is instead built where it actually matters here, on checkout initiation, which makes real calls to an external payment provider), automatic renewal (each period is a single, separate payment -- there is no recurring billing), more than one paid plan or a downgrade path (not requested, and downgrading before a paid period ends would mean forfeiting money already paid, which sits alongside refunds and disputes as explicitly out of scope), a background job to reconcile abandoned checkouts (an abandoned or declined payment simply stays `initiated` until someone revisits its return page -- acceptable at this scale, and nothing is lost since the ledger is append-only), and IP allowlisting of Paystack's webhook source (the HMAC signature on every webhook already authenticates the sender, and an IP list would need to be kept current by hand). The full, itemised list, with the reasoning behind each exclusion, is in `DECISIONS.md` under "Deliberately excluded."

## 2. How To Run It

**Prerequisites:** Node.js (a recent LTS), Docker Desktop (for the local Postgres container), and a free Paystack account. Test mode is the account's default state right after signup -- a working test secret key is available immediately from Settings > API Keys & Webhooks, with no separate "enable test mode" step required. (Nothing in this project's own build history ever needed such a step either: every real test payment made throughout development used a key obtained exactly that way, and no BUILD_LOG or DECISIONS entry records ever having to turn test mode on.) The dashboard also has a Live Mode, reportedly gated behind business verification, for later -- this project only ever runs in test mode, so that step is not something this build required or verified firsthand.

1. **Clone and install.**
   ```
   git clone <repo-url> payment-slice
   cd payment-slice
   npm install
   ```

2. **Create `.env`.** Copy `.env.example` to `.env` and fill in the values. The three variables, exactly as `.env.example` documents them:

   | Variable | Where it comes from |
   |---|---|
   | `DATABASE_URL` | Fixed for local development: `postgresql://payment:payment@localhost:5434/payment` -- matches the credentials and port `docker-compose.yml` defines. No account or external service needed. |
   | `APP_URL` | `http://localhost:3002` for local development. Used to build the Paystack callback URL the customer is sent back to after paying, and to check that API requests come from this same origin (CSRF protection). |
   | `PAYSTACK_SECRET_KEY` | From the Paystack dashboard, in **test mode**: Settings > API Keys & Webhooks > Test Secret Key (starts with `sk_test_`). Server-only -- it is both the bearer token for every Paystack API call and the key Paystack's webhook signature is computed with, so no separate webhook secret is needed. Never put a live key (`sk_live_`) here. |

   This project never creates, reads or edits `.env` on its own; only `.env.example` (placeholders and comments) is committed.

3. **Start the database.**
   ```
   npm run db:up
   ```
   Brings up a local Postgres 18 container on host port 5434 (port 5432 is used by another local Postgres instance on this machine, and 5433 by a sibling project's; 5434 was picked to avoid both). Data is kept in a named Docker volume (`payment-slice-pgdata`) that survives restarts.

4. **Run the migrations and generate the Prisma client.**
   ```
   npm run db:migrate
   ```
   This runs `prisma migrate dev` **and then** `prisma generate` in one command. Running only `prisma migrate dev` by hand is a real trap: Prisma 7 no longer regenerates the client automatically after a migration, so the app will fail at runtime with something like `Cannot read properties of undefined (reading 'count')` on any model touched since the last generate, even though the database itself is perfectly up to date. Always use `npm run db:migrate`, not the bare Prisma command.

5. **Seed the test users (optional, but needed to sign in without building a sign-up flow, since there isn't one).**
   ```
   npm run db:seed
   ```
   Creates `alice@example.com`, `bob@example.com` and `carol@example.com`, all with the password `payment-slice-test-1`. This is a fixed, deliberately public, local-only test password (see `DECISIONS.md`); the script refuses to run against anything but a local database as a safeguard.

6. **Start the app.**
   ```
   npm run dev
   ```
   The app runs at **http://localhost:3002** (not Next.js's usual 3000: that port is already used by another local project on this machine, and 3001 by a sibling project). Sign in with one of the seeded users at `/sign-in`, then visit `/plans` to start a real Paystack test-mode checkout.

7. **(Optional) Prisma Studio**, to browse the database directly:
   ```
   npm run db:studio
   ```
   Runs on **http://localhost:5557** (5555 and 5556 are already used by other local projects/tooling on this machine).

Receiving a real Paystack webhook locally requires exposing this app to the internet (a tunnel), which is not needed just to see the app run -- checkout, payment and the return-page fulfilment path all work over plain `npm run dev` on their own, since the return page verifies and fulfils a payment the same way the webhook does. Tunnel setup is covered separately, where the webhook-handling work itself is documented.

## 3. The Flow, Step By Step

**Starting a checkout.** A signed-in person chooses a plan on `/plans` and the browser posts `{ billingInterval }` to `POST /api/checkout` -- nothing else; the price is never sent by the client. The route checks the same-origin header (CSRF), the session, and a sliding-window rate limit (at most 5 checkout attempts per person in any 10-minute stretch, every attempt counted, including ones that later fail -- see `DECISIONS.md` for why an exact sliding window was chosen over a fixed one). `initiateCheckout()` then: refuses if the person already has an active subscription; looks up the plan's price from server-side config (`src/config/plans.ts`), never from the request; generates our own reference (`pslice-` + a UUID); and writes a `payment_log` row with `event_type = 'initiated'` **before** ever calling Paystack, so the amount we expect is on record before the customer can reach Paystack's payment page at all. Only then does it call Paystack's `/transaction/initialize` and, on success, the browser is sent to the `authorization_url` it returns. If Paystack's call fails, a `failed` row is appended (the `initiated` row is never touched -- `payment_log` is append-only) and the person sees a generic "try again" message.

**Paying, and coming back.** The customer pays on Paystack's own hosted page. Paystack then does two things, independently, in no guaranteed order:

- **Redirects the browser** to `APP_URL` + `/checkout/return?reference=...`.
- **Sends a webhook** (`POST /api/webhooks/paystack`, event `charge.success`) to whatever endpoint is currently reachable (in local development, a tunnel -- see below).

Both of these are just *notifications that something happened*; neither is trusted to say what. Both hand off to the exact same function, `fulfilTransaction()`, so there is one, and only one, place that decides whether a payment is real:

1. Is the reference one of ours, and (for the return page) does it belong to the person asking? If not: `unknown`, nothing written.
2. Already fulfilled in our own ledger? If so: stop, no Paystack call needed (`already_fulfilled`).
3. Otherwise, call Paystack's `GET /transaction/verify/{reference}` **ourselves**, server-to-server, with the secret key. This is the only step that can ever say a payment happened -- never the redirect, never the webhook body's own claimed status.
4. Compare Paystack's answer against the order we recorded at initiation (`evaluateTransaction()`, `src/lib/checkout/evaluate.ts`): same reference, same amount, same currency, and Paystack's status is `success`. Anything else is either `not_paid` (failed, abandoned, reversed, or an unrecognised status -- none of these are treated as final; a real test during development showed a card declined and the same reference paid three hours later) or a `mismatch` (paid, but not what we asked for -- recorded once, nothing activated).
5. If it matches: inside one database transaction, under a per-reference advisory lock (so the webhook and the return page arriving at the same instant cannot both fulfil), re-check nothing has changed since step 2, then write a `verified` row, a `fulfilled` row, and activate or extend the subscription, all together or not at all.

**Webhook-specific handling** (`src/lib/paystack/webhook-handler.ts`) happens *before* any of the above: the request's arrival time is stamped on the very first line (before the body is even read), the raw body is size-capped, and its HMAC-SHA512 signature (`x-paystack-signature`, keyed with the same secret key) is checked over the exact bytes received -- all before the body is parsed or a database touched. A missing or wrong signature is a 401 with nothing else done. Once verified, the event is recorded in `webhook_events` keyed by `(provider, event_type, provider_transaction_id, provider_status)`; a redelivery of the same event finds that key already claimed and is a no-op (`duplicate_event`), proven live in `docs/evidence/webhook-idempotency.md`.

**Cancelling.** `POST /api/subscription/cancel` sets `cancel_at_period_end = true` (and stores an optional reason) on the existing subscription row -- `status` stays `'active'`. Nothing else changes, no cron job runs, and no separate "expire" step exists: `describeSubscription()` already compares `current_period_end` to the current time on every read, so a cancelled subscription simply reports as Free the moment its period ends, the same read-time check that already governs an ordinary lapsed subscription. `POST /api/subscription/resume` is the exact inverse, reachable only while still in-period.

**Upgrading.** `POST /api/subscription/upgrade` is only reachable for someone currently on Pro monthly, active, and not set to cancel. `quoteUpgrade()` (`src/lib/billing/proration.ts`) computes a prorated charge from the real, actual length of the current period and how much of it is left -- never an assumed 30 days. That amount, not the fixed yearly price, is what gets written to the `initiated` row and sent to Paystack; from there it goes through the exact same verify-then-fulfil pipeline as any other payment. On fulfilment, `activateSubscription()`'s SQL replaces the period (starts today, runs a full year) rather than stacking the new year on top of the old monthly end date, because the change of interval is itself the signal that this is an upgrade, not a renewal -- a second payment for the *same* interval while already active still stacks, exactly as it always has.

## 4. The Data Model

Four tables belong to this slice (`prisma/schema.prisma`); `users` and `sessions` are reused as-is from auth-slice's session mechanism, permitted by the brief and documented as such.

**`subscriptions`** -- one row per user, and its existence *is* the signal: a user with no row is on the Free plan; there is no `plan_id = 'free'` row to keep in sync. A row therefore always describes a paid period, so almost every column can be `NOT NULL`. `user_id` is `UNIQUE` (at most one current subscription per person, enforced by the database, not just app logic). `status` is `CHECK IN ('active', 'past_due', 'canceled')` -- but nothing in the app ever writes `'canceled'` today: a cancellation only ever sets `cancel_at_period_end = true` and leaves `status = 'active'` for the rest of the paid period, and `'canceled'` is deliberately reserved for a possible future admin action (an immediate revoke), not an oversight. Whether someone currently has access is never read from `status` alone: it's `status = 'active' AND current_period_end > now()`, checked fresh on every request (`describeSubscription()`). `cancellation_reason` has a `CHECK` that it can only be set alongside `cancel_at_period_end` or `status = 'canceled'` -- a reason can never exist without a cancellation to explain. There is deliberately no money column here: the price actually paid lives only in `payment_log`, so there is never a second copy of an amount that could disagree with the first.

**`payment_log`** -- append-only at the database level: a trigger (`payment_log_append_only`, in the hand-written migration SQL) rejects `UPDATE`, `DELETE` and `TRUNCATE` outright; a correction is a new row, never an edit. One row is written per lifecycle event of one transaction (`event_type IN ('initiated', 'verified', 'fulfilled', 'failed')`), so a transaction's full history -- including every mismatch and every eventually-successful retry -- is always there to read back, never overwritten. `amount` is an `Int` (integer kobo, `CHECK amount > 0`), never a decimal: Postgres silently rounds a fractional value cast into an integer column rather than rejecting it, discovered and documented early in this project, which is exactly why amounts are validated as integers before they ever reach a query, not relied on the column type alone. `currency` sits next to it with its own `CHECK currency ~ '^[A-Z]{3}$'`, because an amount without a currency is meaningless. Two partial unique indexes (`payment_log_one_fulfilment_per_tx_ref`, `payment_log_one_fulfilment_per_provider_id`) are a defense-in-depth backstop: even if the advisory lock and the in-transaction re-check described in Section 3 were both somehow bypassed, the database itself still physically cannot store two `fulfilled` rows for the same transaction. `raw_response` stores only the trimmed evidence Paystack returned (9 whitelisted fields: id, status, reference, amount, currency, paid_at, channel, gateway_response, domain) -- never the full response, which carries the customer's email and a reusable card `authorization` object the brief forbids storing.

**`webhook_events`** -- the idempotency ledger, separate from `payment_log` because it records something different: not "what happened to a payment" but "which deliveries have we already acted on." `UNIQUE (provider, event_type, provider_transaction_id, provider_status)` is the actual guarantee: the handler claims an event by inserting this row, so a genuinely simultaneous redelivery is serialised by the database itself, not by application logic that could race. `status` is part of the key (not just the transaction id) so a real status change for the same transaction is a new event rather than a dropped "replay." `received_at` is stamped by the application on the very first line of the handler, before the body is even read, so it reflects true arrival time, not row-write time -- three of the earliest real rows predate that fix and are left exactly as they were captured, documented as "about processed_at" rather than quietly corrected, because they are real evidence and no migration was needed to fix the column's meaning going forward.

**`rate_limit_attempts`** -- backs the sliding-window rate limiter on checkout (and the return page's own, separate limit). One row per *allowed* attempt (a denied attempt is never stored), so per key this table never holds more than `max` rows; whether a new attempt is allowed is "fewer than `max` rows for this key are newer than the window," checked and inserted under an advisory lock so the check-then-insert can't race across concurrent requests. It replaced an earlier fixed-window table after real-world testing showed the fixed-window version letting one extra request through at a window boundary -- see `DECISIONS.md` for the exact failure and the negative-control test that proves the replacement has teeth.

## 5. The Concepts

### Minor units, and why money is never a decimal

**What it is.** Storing and calculating every amount as a whole number of the currency's smallest unit -- kobo for naira -- instead of naira-and-decimal (e.g. `2820000` kobo, never `28200.00`).

**Why it's needed.** Binary floating-point cannot represent most decimal fractions exactly (`0.1 + 0.2 !== 0.3` in every mainstream language), and a `decimal`/`numeric` column carries rounding-mode and precision questions of its own. Both are ways for a stored amount to silently drift from the amount actually charged. An integer has none of that ambiguity: `2820000` is exactly `2820000`, everywhere, forever.

**How I implemented it.** `payment_log.amount` is a Postgres `Int` with `CHECK amount > 0`, and `currency` sits next to it with `CHECK currency ~ '^[A-Z]{3}$'` -- an amount without its currency is treated as invalid by construction, per `AGENTS.md`'s money rule.

```typescript
// src/config/plans.ts
export const PLAN = {
  id: "pro",
  name: "Pro",
  currency: "NGN",
  prices: {
    monthly: { amountKobo: 300_000 }, // NGN 3,000
    yearly: { amountKobo: 3_000_000 }, // NGN 30,000
  },
} as const;
```

**What I chose against, and why.** A `decimal`/`numeric` column: forbidden outright by the project's money rule, for the reason above. `BigInt`: considered for headroom beyond a 4-byte int's ~NGN 21.4 million ceiling, rejected because it forces `bigint` handling through the whole TypeScript layer for no benefit at subscription prices. I also found, while testing the schema, that **Postgres itself will not save me from a decimal by accident**: inserting `12.5` into an `Int` column doesn't error, it silently rounds to `13`. That means the database's `Int` type is not a complete guarantee on its own -- the real protection is validating every amount as an integer (Zod) *before* it reaches a query, which is what every write path in this project does.

### The payment lifecycle: initiation, verification and fulfilment are three separate things

**What it is.** A payment is never treated as one event. It is three, and each is its own `payment_log` row: **initiation** ("we asked to start a payment for this amount"), **verification** ("Paystack itself confirmed, server-to-server, that it was paid"), and **fulfilment** ("we granted the subscription because of that confirmation").

**Why it's needed.** Collapsing these into one step is exactly how a system ends up trusting a client-controlled signal (a redirect, a webhook's own claimed status) to grant something valuable. Keeping them separate means there is a durable record of what we *asked for*, independent of what anyone later *claims happened*, and a third record of what we actually *did about it* -- and the middle step is the only one allowed to move money's meaning from "claimed" to "real."

**How I implemented it.** `initiateCheckout()` writes the `initiated` row *before* Paystack is ever called, so the expected amount is on record before the customer can reach the payment page. `fulfilTransaction()` is the only place that ever writes `verified` or `fulfilled`, and it only does so after calling Paystack's own verify endpoint itself:

```typescript
// src/lib/checkout/fulfil.ts
const verified = await verifyTransaction(txRef, input.secretKey, { fetch: deps.fetch });
if (!verified.ok) { /* ...cannot_verify... */ }
const evaluation = evaluateTransaction(order, verified.transaction);
switch (evaluation.kind) {
  case "fulfil":
    return commitFulfilment(client, { userId: initiated.userId, order, paystack: verified.transaction, ... });
```

Both the return page (`/checkout/return`) and the webhook hand the *reference only* to this one function; neither is trusted to say whether the payment succeeded.

**What I chose against, and why.** Granting access straight from the redirect the customer's browser lands on, or from a webhook body's own `status` field: both are exactly the "trust the client" mistake `AGENTS.md`'s payment-integrity rule exists to prevent -- either can be replayed, delayed, or simply never arrive. I also rejected calling Paystack's verify endpoint *inside* the database transaction that writes the result, because a network call should never hold a database lock or connection open.

### The payment log, and what it would prove in a dispute

**What it is.** `payment_log`: one row per lifecycle event of a transaction, and it is append-only at the database level -- a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` outright, so a correction is always a *new* row, never an edit of an old one.

**Why it's needed.** If a customer disputes a charge months later, the only trustworthy answer to "what actually happened" is a record that could not have been quietly altered afterwards, by a bug or by anyone. An editable table can't offer that; an append-only one can prove it structurally, not just by policy.

**How I implemented it.**

```sql
-- prisma/migrations/20260921033354_init_payment_core/migration.sql
CREATE FUNCTION payment_log_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_log is append-only: % is not allowed (add a new row instead)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_log_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON payment_log
  FOR EACH STATEMENT EXECUTE FUNCTION payment_log_reject_mutation();
```

In a real dispute, the rows for one `tx_ref` would show: the exact amount and currency *we* asked for at initiation, before the customer could have paid anything different; the trimmed evidence Paystack itself returned at verification (id, status, amount, currency, channel, `paid_at`, `gateway_response`); and the moment fulfilment happened. If a payment was ever declined and paid later on the same reference, or paid for the wrong amount, that whole sequence is still there to read back -- nothing about an earlier attempt is ever overwritten by a later one. `docs/evidence/subscription-extension.md` and `docs/evidence/upgrade-proration.md` are exactly this: real ledger rows read back after the fact, used as evidence.

**What I chose against, and why.** Enforcing append-only "by convention" (nothing stops a future bug or a careless script from breaking it) or by revoking the application's database privileges (the dev setup runs as the table owner, so a `REVOKE` wouldn't bind it -- a trigger does, regardless of who's connected).

### Idempotency in payments

**What it is.** The guarantee that processing the *same* payment notification twice has the same effect as processing it once -- no double grant, no duplicate ledger entry.

**Why it's needed.** Paystack (like any payment provider) can and does redeliver a webhook -- on a timeout, a retry, or simply because it doesn't know we already processed it. Without idempotency, a redelivered "you were paid" message could extend a subscription a second time for one payment, or double-log a transaction that only happened once.

**How I implemented it.** `webhook_events` has `UNIQUE (provider, event_type, provider_transaction_id, provider_status)`. The handler doesn't check-then-insert (two concurrent requests could both pass the check); it *claims* the event by inserting the row and lets the database's own unique constraint be the actual guarantee:

```typescript
// src/lib/checkout/fulfil.ts
if (event && (await eventAlreadyRecorded(client, event))) return { outcome: "duplicate_event" };
```

Separately, `payment_log` has two *partial* unique indexes (`WHERE event_type = 'fulfilled'`), one on `tx_ref` and one on `provider_transaction_id`, as a database-level backstop even if the application-level checks were somehow bypassed. This was proven, not just asserted: with the advisory lock and the in-transaction re-check deliberately switched off in a test, 20 simultaneous callers all reached the `fulfilled` insert, and the database's unique index -- not application logic -- stopped 19 of them, rolling back their whole transactions. I also proved it live against real data: replaying a real, genuinely-signed webhook twice against the running app produced the exact same `webhook_events` row both times, with the row count and `processed_at` both unchanged (`docs/evidence/webhook-idempotency.md`).

**What I chose against, and why.** A `SELECT`-then-`INSERT` check (a race two concurrent deliveries can both pass); keying idempotency on the transaction id alone, without status (would silently swallow a genuine status change on the same transaction, e.g. pending then successful, as if it were a replay).

### Webhook signature verification

**What it is.** Checking that a webhook request genuinely came from Paystack, by recomputing the HMAC-SHA512 of the raw request body with the shared secret key and comparing it, in constant time, to the `x-paystack-signature` header Paystack sends.

**Why it's needed.** `POST /api/webhooks/paystack` is a public URL with no session and no same-origin check (Paystack calls it server-to-server, so neither mechanism applies). Without signature verification, *anyone* who finds that URL could POST a fake "charge.success" body and grant themselves a subscription for nothing.

**How I implemented it.** The check runs over the **exact raw bytes** received, before anything is parsed -- re-serialising a parsed JSON body and hashing *that* would only happen to match when the formatting is already compact, and would mean acting on effectively unauthenticated input the moment it didn't:

```typescript
// src/lib/paystack/webhook.ts
export function isValidWebhookSignature(rawBody: Buffer, header: string | null | undefined, secretKey: string): boolean {
  if (!header || !secretKey) return false;
  const expected = Buffer.from(createHmac("sha512", secretKey).update(rawBody).digest("hex"), "utf8");
  const received = Buffer.from(header, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

`timingSafeEqual` matters: a naive `===` comparison leaks, through response timing, how many leading bytes matched, which is a real (if slow) way to forge a signature byte-by-byte. This was confirmed against two real Paystack test-mode deliveries and three independent known-answer HMAC-SHA512 vectors computed with `openssl`, not just trusted from documentation.

**What I chose against, and why.** IP allowlisting Paystack's webhook source: the real deliveries captured during development came from two different Paystack IP ranges, so an allowlist would need their full published list kept current by hand, and the signature already authenticates the request regardless of source address. Parsing the body before checking the signature: would mean doing work on, and branching on, content nobody has confirmed is genuinely from Paystack.

### Proration

**What it is.** Charging only for the *unused* portion of a person's current paid period when they switch to a more expensive plan mid-cycle, rather than either the full new price or a silent, unpriced swap.

**Why it's needed.** Someone on Pro monthly, twelve days into a thirty-day period, who upgrades to yearly, has already paid for eighteen days of monthly service they're about to give up. Charging them the full yearly price on top of that double-charges those eighteen days; silently swapping the plan for free under-charges. Proration is the arithmetic that makes the switch fair in both directions.

**How I implemented it**, with the actual worked example from `DECISIONS.md`:

```typescript
// src/lib/billing/proration.ts
const periodLengthMs = row.currentPeriodEnd.getTime() - row.currentPeriodStart.getTime();
const remainingMs = row.currentPeriodEnd.getTime() - now.getTime();
const unusedFraction = periodLengthMs > 0 ? remainingMs / periodLengthMs : 0;
const creditKobo = Math.round(unusedFraction * monthlyPriceKobo);
const chargeKobo = Math.max(1, yearlyPriceKobo - creditKobo);
```

Day 12 of a 30-day monthly cycle (18 days unused):

```
unused_fraction = 18 / 30                    = 0.6
credit_kobo     = round(0.6 * 300,000)       = 180,000 kobo   (NGN 1,800)
charge_kobo     = 3,000,000 - 180,000        = 2,820,000 kobo (NGN 28,200)
```

This is not hypothetical: a real upgrade completed during development (bob, `docs/evidence/upgrade-proration.md`) charged exactly 2,715,766 kobo, and hand-working the same formula against his real elapsed time (about 1.5766 of his 30 days used) reproduces that exact number. "Unused" is measured against the period's own *real* length, not an assumed 30 days, because Postgres clamps month-end arithmetic (31 January + 1 month = 28 February) so a monthly period isn't always 30 days.

**What I chose against, and why.** Assuming a flat 30-day month for every proration (wrong the moment the period spans a shorter or longer calendar month); stacking the new year on top of the remaining monthly time instead of replacing the period (this would double-count the unused time -- it's already been converted into a credit against the price, so also extending the clock on top of that would give it away twice).

### Cancellation and period-end access

**What it is.** Cancelling only ever sets `cancel_at_period_end = true` (plus an optional stored reason); `status` stays `'active'` for the rest of the period already paid for. Access is never cut off the moment someone clicks Cancel.

**Why it's needed -- the reasoning.** The customer has already paid for a fixed period of access. Revoking that access immediately, while keeping the money already charged for the remainder of it, is the same shape of unfairness proration exists to prevent in the other direction: taking payment for time not delivered. This is also the behaviour real subscription services converge on (Netflix, Spotify, and most SaaS billing all let a cancellation take effect at period end, not instantly), not an invented rule -- "cancel" means "don't charge me again," not "take back what I already paid for."

**How I implemented it.**

```typescript
// src/lib/billing/cancel.ts
export async function cancelSubscription(userId: string, reason: string | undefined, client = db) {
  const row = await client.subscription.findUnique({ where: { userId }, select: { /* ... */ } });
  const view = describeSubscription(row, new Date());
  if (view.kind !== "pro") return { outcome: "not_subscribed" };
  if (view.endsAtPeriodEnd) return { outcome: "already_canceled" };
  await client.subscription.update({ where: { userId }, data: { cancelAtPeriodEnd: true, cancellationReason: reason ?? null } });
  return { outcome: "canceled", endsOn: view.activeUntil };
}
```

No cron job or scheduled task ever flips a cancelled subscription off: `describeSubscription()` already compares `current_period_end` to the current time on *every* read, for every subscriber, cancelled or not, so a cancelled subscription simply starts reporting as Free the instant its period ends -- the exact same mechanism that already handles an ordinary lapsed (never-cancelled) subscription, with zero new machinery. This was proven against real data too: bob's real subscription was cancelled through the live endpoint, screenshotted showing `status: Active, will end` with the period-end date still intact, then resumed and confirmed back to its exact prior values (`docs/evidence/subscription-cancelled.md`).

**What I chose against, and why.** Flipping `status` to `'canceled'` immediately (cuts off access already paid for -- the reasoning above is exactly why this was rejected); a scheduled job to expire cancelled subscriptions at period end (unnecessary -- the read-time check already does this for every other "has the period ended" case, so a job would be redundant machinery solving an already-solved problem).

### Why cards are never stored (PCI scope)

**What it is.** Not persisting any card data anywhere in this application's database -- not the number, not a masked version, not a reusable charge token.

**Why it's needed.** Storing cardholder data (even just a card's last 4 digits and expiry, and especially a token that can charge the card again) pulls an application into PCI-DSS scope -- the Payment Card Industry Data Security Standard's compliance requirements for anyone who stores, processes or transmits card data. Staying out of that scope entirely is both what the brief requires and, for a project this size, the only sane choice: PCI compliance is a serious, ongoing operational burden, not a checkbox.

**How I implemented it.** A single Zod schema is the *only* thing allowed to turn a Paystack response into something this app stores, and it works by strict allow-list, not by trying to remember what to strip:

```typescript
// src/lib/paystack/evidence.ts
export const transactionEvidenceSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  reference: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  paid_at: z.string().nullish(),
  channel: z.string().nullish(),
  gateway_response: z.string().nullish(),
  domain: z.string().nullish(),
});
```

Zod strips every key not listed here. Paystack's real replies, captured during development, also carry the customer's email and phone and a full `authorization` object -- card bin, last 4 digits, expiry, bank, brand, a card `signature`, and an `authorization_code` explicitly marked `reusable: true` (a token that can charge that same card again later). None of that reaches this schema's output, which is the *only* thing ever written to `payment_log.raw_response` or `webhook_events.payload`. This was tested directly: deliberately adding 50 card-like and unknown fields to a test payload still leaves exactly the 9 allowed keys in what gets stored.

**What I chose against, and why.** A denylist that removes known-sensitive fields by name: misses any field Paystack adds later, and fails *silently* -- nobody finds out until it's already leaked. Hashing or encrypting the card object instead of dropping it: still means keeping card data (and now a key that can unlock it) in this database, which does not remove it from PCI scope, only obscures it.

### Rate limiting on payment endpoints

**What it is.** Capping how many checkout attempts one signed-in person can start in a rolling window -- 5 per any 10-minute stretch, counted exactly, not by a coarser approximation.

**Why it's needed.** Checkout initiation calls a real external payment provider. Unlike sign-in (deliberately left unlimited -- see Section 1), an unlimited checkout endpoint could be used to hammer Paystack's API on someone else's behalf, or simply to abuse a resource that costs real API calls, for no legitimate reason a normal user would ever need.

**How I implemented it**, after a real bug was found in an earlier version:

```typescript
// src/lib/security/rate-limit.ts
await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) AS l`;
// ...count rows for this key newer than the window...
if (count < limit.max) {
  await tx.$executeRaw`INSERT INTO rate_limit_attempts (key) VALUES (${key})`;
  return { allowed: true, /* ... */ };
}
```

Each attempt runs under a per-key advisory lock so a true sliding window can be counted correctly even when requests arrive at the exact same instant, and only *allowed* attempts are stored, so hammering a blocked endpoint doesn't extend the block. This replaced a fixed-window design after the owner's own manual testing found it letting **6** successful requests through where the rule says 5 -- a fixed window resets on clock boundaries (`:00`, `:10`, ...), so 5 requests just before a boundary and 5 more just after can both pass within seconds. The negative-control test in `scripts/check-rate-limit.ts` proves this isn't just asserted: with the lock deliberately removed, the exact same count-then-insert logic lets up to 10-13 requests through in every trial, and with it in place, exactly 5, every time, in 20 of 20 trials.

**What I chose against, and why.** The original fixed-window design (kept a `rate_limit_buckets` table keyed by `(key, window_start)`; simpler, but demonstrably not what "5 per 10 minutes" actually means, as the real test above showed). A per-IP limit instead of per-user: the endpoint already requires sign-in, and IP limits depend on trusting `X-Forwarded-For`, which anyone can spoof unless a proxy we control sets it. An in-memory counter: lost on process restart and not shared across processes, so it wouldn't hold under Next.js's multi-worker model.

## 6. What Went Wrong

This project's own `BUILD_LOG.md` has far more than three entries; these are the strongest and most illustrative, spanning a real user-facing bug, a subtle semantic bug in a column nothing ever read, two tooling/ORM surprises, a database-behaviour assumption that turned out false, and a mistake I made twice in a row in my own test code.

### A fixed-window rate limiter let 6 requests through instead of 5

- **Symptom.** During the owner's own manual browser testing, alice got 6 successful checkout requests before the first `429`, not 5.
- **Investigation.** The database showed one attempt at 12:57:18 (inside the fixed window 12:50:00-13:00:00) and five more at 13:03:07-13:03:13 (inside the next window, 13:00:00-13:10:00); the sixth attempt of that second window made its counter 6 and was finally blocked. That is the *correct* behaviour of a fixed window -- it resets on clock boundaries (`:00`, `:10`, ...) -- but it is not what "5 per 10 minutes" actually says. In the worst case (5 requests at 12:59:59 and 5 more at 13:00:00) 10 requests pass within seconds of each other.
- **Cause.** My own design choice of a fixed window, not a coding error. I had written the 2x-burst behaviour down as a known limit in `DECISIONS.md` but judged it minor -- and every one of my own concurrency and API tests ran inside a single window, so none of them could have shown the flaw.
- **Fix.** Replaced it entirely with an exact sliding window: one row per *allowed* attempt, counted under a per-key advisory lock so the count-then-insert can't race. Reproduced the exact real incident three separate ways against the new limiter (via the concurrency test, a negative control with the lock removed, and the real HTTP endpoint) and confirmed it now gives exactly 5, never 6. See "Rate limiting on payment endpoints" in Section 5 for the full before/after.

### `webhook_events.received_at` didn't mean "received"

- **Symptom.** While checking bob's real payment, a `webhook_events` row showed `received_at` **one millisecond after** `processed_at` -- an event that looked received a moment after it had finished being processed.
- **Investigation.** Checked all three real rows at the time: `received_at` was 6, 4 and 1 ms *after* `processed_at`, never before. Traced why: the row is only inserted at the *end* of processing (deliberately, so a crash leaves no half-claimed event), and `received_at` was taking its value from the column's default, which fires when the row is finally written -- not when the request arrived. Nothing had ever recorded the true arrival time at all; it only existed in ngrok's own request log.
- **Cause.** My own naming and design drift: I named the column for an earlier "claim first, then process" design, then built the handler the other way round (process first, insert once, at the end) and never revisited whether the name still fit. No test ever asserted anything about the column's actual meaning, so nothing caught the drift.
- **Fix.** Given a choice between three fixes, the owner chose to make the name *true*: the handler now stamps the arrival time on its very first line -- before the body is even read -- and passes that stamp through to the row. No migration, no rename. The three pre-existing real rows keep their old (wrong) values on purpose, documented in the schema as "about `processed_at`," because they are real evidence and rewriting them would have been dishonest, not a fix.

### Prisma's client silently went stale after a migration

- **Symptom.** `db.paymentLog` was `undefined` at runtime -- `TypeError: Cannot read properties of undefined (reading 'deleteMany')` -- immediately after `prisma migrate dev` had reported the database was "now in sync with your schema."
- **Investigation.** `prisma migrate status` and `prisma migrate diff` both agreed the database was fine; neither looks at the generated *client*, which is a separate build artifact. Prisma 7's `migrate dev` no longer regenerates the client automatically, and the client on disk had been generated at scaffold time from an empty schema.
- **Cause.** My own wrong assumption that a migration regenerates the client it hands to the app. The project's `db:migrate` script was already written as `prisma migrate dev && prisma generate` for exactly this reason (copied from a sibling project's own hard-earned lesson) -- but I'd run the bare Prisma command by hand instead of the npm script.
- **Fix.** Ran `prisma generate` directly, then used `npm run db:migrate` from then on. This is now called out explicitly in Section 2's setup steps as a named trap, not left to be rediscovered.

### A misconfigured trigger error code produced a misleading Prisma error

- **Symptom.** Attempting to `UPDATE` a `payment_log` row through Prisma Client failed with "Foreign key constraint violated" -- which is not what happened.
- **Investigation.** The rejection itself was correct (the append-only trigger had fired); only the reported reason was wrong. A raw SQL `TRUNCATE` on the same table showed the real message: "payment_log is append-only: TRUNCATE is not allowed." The trigger had been written to raise SQLSTATE `23001` (`restrict_violation`).
- **Cause.** Prisma maps SQLSTATE `23001` specifically to its own foreign-key error code. I'd picked that SQLSTATE because "restricted operation" sounded right, without checking how the ORM on top of it actually reports that code back to application code.
- **Fix.** A second migration re-created the trigger function using Postgres's default `raise_exception` code instead, so Prisma now surfaces the real message verbatim. (A second migration was necessary because the first had already been applied -- migrations here are never edited after the fact.)

### Postgres silently rounds a decimal into an integer column

- **Symptom.** Not an error: inserting the amount `12.5` directly into `payment_log.amount` (an `Int` column) *succeeded*, storing `13`.
- **Investigation.** I had expected a rejection and tested it deliberately, as part of writing the constraint tests. Postgres casts a numeric literal to `Int` by *rounding*, not by refusing it -- there is no error to catch.
- **Cause.** My own assumption that an integer-typed column is a complete guarantee against a decimal amount was simply wrong at the database level.
- **Fix.** No schema change is possible -- a `CHECK` constraint can't see the original, pre-cast value. Documented plainly in `DECISIONS.md` instead: every amount must be validated as an integer (Zod) in application code *before* it ever reaches a query; the column type alone is not sufficient protection. This is also the reasoning written up in Section 5 under "Minor units."

### The same test-authoring mistake, twice: forgetting to pass the isolated database client

- **Symptom.** Twice, in two unrelated features (cancellation, then upgrade-with-proration), a freshly written test script's "logic" checks failed in a way that looked like the *feature* was broken -- e.g. `cancelSubscription()` returning `not_subscribed` for a user that had just been given an active subscription moments earlier in the very same script.
- **Investigation.** Both times, the cause turned out to be identical: `cancelSubscription()`/`resumeSubscription()`/`initiateUpgrade()` all default their `client` (or `db`) parameter to the app's real, shared database singleton, and my test helper had called them without passing the isolated test schema's client explicitly. Every call was silently running against the real (empty-for-this-throwaway-user) public schema instead of the temporary one, and returned a *plausible-looking wrong answer* rather than crashing -- which is what made it look like a real bug the first time.
- **Cause.** My own test code, not the application, in both cases -- and the second occurrence is the more interesting fact: writing it up in detail the first time (see `BUILD_LOG.md`) did not stop me from making the identical mistake in a different function two features later.
- **Fix.** Both scripts now pass the isolated client explicitly on every call, with a comment in the upgrade test pointing back at the earlier entry so a future instance of the same mistake is at least caught faster. See Section 8 for what I'd change structurally so this stops being possible to get wrong at all.

## 7. What This Slice Does Not Handle

### Deliberately out of scope (a decision, not a shortfall)

These are all recorded in `DECISIONS.md` under "Deliberately excluded," with the reasoning behind each:

- **Sign-up, email verification, password reset.** Test users are seeded directly; the brief does not ask for account creation, and none of the three is needed to identify a signed-in person for this slice.
- **Rate limiting on sign-in.** The session mechanism is reused as-is from auth-slice; rate limiting is built where it actually matters here, on checkout, which makes real external calls.
- **Automatic renewal.** Each period is a single, separate payment. There is no recurring billing, and so nothing charges anyone without their initiating it.
- **More than one paid plan, and downgrading.** Only "Pro" exists. A downgrade path (yearly to monthly, or Pro to Free before the period ends) was never requested, and "Free before the period ends" would mean forfeiting money already paid -- which sits alongside refunds and disputes, explicitly out of scope.
- **Refunds and disputes.** Not in the brief. The append-only ledger exists precisely so a dispute *could* be investigated from real data, but no in-app refund or dispute-resolution flow exists.
- **Every webhook event other than `charge.success`.** Transfers, refunds, disputes and anything else Paystack might send are acknowledged with a 200 and not stored, since nothing in this slice needs to act on them.
- **IP allowlisting of Paystack's webhook source.** The HMAC signature already authenticates every request; real captured deliveries came from more than one Paystack IP range, so an allowlist would need to be kept current by hand for no added safety.
- **A background job to reconcile abandoned or stuck checkouts.** An abandoned or declined payment simply stays `initiated` until someone revisits its return page. Acceptable at this scale, and nothing is lost -- the ledger is append-only, so a stuck row is always there to find with a plain query.
- **An admin interface of any kind.** `status = 'canceled'` is a real, reserved value the schema and `describeSubscription()` both already understand, but there is no code path anywhere that ever writes it (see Section 5, "Cancellation and period-end access") -- it is reserved for a possible future admin action, such as an immediate revoke, that does not exist yet.

### Genuine gaps -- not scope decisions, just not fully covered

These are honest limitations, not choices made on purpose:

- **No browser-driven end-to-end tests anywhere in this project.** Every automated check is either a direct call to application logic against an isolated database, or an HTTP call to a real running server -- there is no Playwright/Cypress-style test that drives an actual browser. Notably, the sign-in *form's* own client-side behaviour (typing, clicking, the loading state) was never exercised this way; only its server-rendered output and its API were. In practice, the two real bugs that mattered most in this project (the rate-limiter burst, and the `received_at` mislabeling) were found by the owner's own manual browser testing, not by any automated suite -- which says something about the limits of what the test scripts in this repo actually cover.
- **The rate limiter's behaviour under a real database outage was never observed.** It's *written* to fail closed (an error means the request is not allowed through), and that line of code is simple enough to trust, but no test actually simulates Postgres being unreachable mid-check.
- **No load or stress testing beyond the concurrency scripts' 10-20 simulated simultaneous callers.** That is enough to prove the locking and idempotency guarantees hold under contention, but it says nothing about how the app behaves under a realistic production traffic volume, and none has ever been thrown at it.
- **Webhook signature verification depends on reading the raw request body exactly once, before any other code touches it.** That holds in this Next.js App Router route today, but it's an assumption about the runtime, not something structurally enforced -- a future refactor that adds middleware ahead of this route, or changes how the body is read, could silently break it without any test catching it, since nothing currently asserts *that* property directly (only that a correct signature is accepted and an incorrect one is not, under today's code path).
- **No monitoring, alerting or dashboard of any kind.** A stuck `initiated` payment, a run of `cannot_verify` outcomes because Paystack itself is down, or a webhook consistently failing signature verification would all currently be invisible unless someone thought to query the database directly.

## 8. If I Built This Again

The single biggest thing I'd change is making the "isolated test database client must be passed explicitly" rule impossible to violate by accident, instead of relying on remembering to do it. It went wrong twice, in two different features (cancellation, then upgrade-with-proration), in exactly the same shape: a function that defaults its database parameter to the app's real, shared client, called from a test script without that argument, silently running against the wrong schema and returning a plausible-but-wrong answer instead of an obvious crash -- and writing the first occurrence up in detail in `BUILD_LOG.md` did nothing to stop the second. That tells me the fix I actually applied both times (pass the client explicitly, add a comment) was treating a systemic risk as a one-off mistake. A better design would make the unsafe call *not compile*, or at least *not silently succeed* -- for instance, a database-accepting function with no default at all in test-only builds, or a lint rule that flags a call to one of these functions with no explicit client argument from inside `scripts/`. Given how much of this project's real rigor (the advisory locks, the append-only trigger, the partial unique indexes) comes from pushing a guarantee down to a layer where a mistake simply *can't* happen rather than trusting anyone, including myself, to remember a rule, I should have held my own test-authoring conventions to that same standard from the start, instead of only the application code.
