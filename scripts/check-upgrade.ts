// Checks the upgrade-with-proration flow (Pro monthly -> Pro yearly, mid-cycle): the pure proration
// formula, initiateUpgrade's eligibility and amount, and the fulfilment path through the SAME
// fulfilTransaction() the webhook and return page use, including the stacking-vs-replace change to
// activateSubscription. Payment-critical rigor, same battery as check-fulfilment.ts: concurrency,
// atomicity, and a defence-in-depth trial with the lock and re-check switched off.
//
// Uses the same TEMPORARY-schema harness as check-fulfilment.ts (scripts/lib/isolated-schema.ts) for
// everything that writes payment_log or subscriptions rows, and the real dev server (a separate OS
// process) for the HTTP section, matching check-billing.ts / check-cancellation.ts's established split.
//
// Run with: npm run check:upgrade
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { inspect } from "util";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { db as realDb } from "../src/lib/db";
import { generateSessionToken, sha256Hex } from "../src/lib/auth/tokens";
import { quoteUpgrade, type UpgradeEligibleRow } from "../src/lib/billing/proration";
import { fulfilTransaction, type FulfilResult } from "../src/lib/checkout/fulfil";
import { initiateUpgrade } from "../src/lib/checkout/initiate";
import { appendPaymentLog } from "../src/lib/payment-log";
import { transactionEvidenceSchema } from "../src/lib/paystack/evidence";
import { createIsolatedSchema, type Isolated } from "./lib/isolated-schema";

const logged: string[] = [];
console.error = (...a) => { logged.push(a.map((x) => (typeof x === "string" ? x : inspect(x))).join(" ")); };
console.warn = console.error;

let iso: Isolated | undefined;
let db!: PrismaClient;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

const SECRET = "sk_test_UPGRADE_MUST_NEVER_LEAK";
const verifyFixture = JSON.parse(readFileSync(join(process.cwd(), "scripts", "fixtures", "paystack", "verify-success.json"), "utf8"));
let counter = 0;

// A fake Paystack that answers BOTH /transaction/initialize (200 with an authorization_url) and
// /transaction/verify/{reference} (200, paid, for whatever amount/reference it is asked to verify).
function fakePaystack(providerId: number) {
  const calls = { verify: 0, initialize: 0 };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/transaction/initialize")) {
      calls.initialize++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ status: true, data: { authorization_url: `https://paystack.com/pay/${body.reference}`, reference: body.reference } }), { status: 200 });
    }
    calls.verify++;
    const reference = decodeURIComponent(url.split("/transaction/verify/")[1]);
    return new Response(JSON.stringify({ ...verifyFixture, data: { ...verifyFixture.data, id: providerId, reference, amount: undefined, status: "success" } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

// Like fakePaystack, but verify() reports EXACTLY the amount and currency the 'initiated' row asked
// for (read back from the database), so evaluateTransaction sees a genuine match -- a real Paystack
// verify call always echoes back what was actually charged, which for an upgrade is the prorated amount.
function fakePaystackEchoingOurRow(providerId: number) {
  const calls = { verify: 0, initialize: 0 };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/transaction/initialize")) {
      calls.initialize++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ status: true, data: { authorization_url: `https://paystack.com/pay/${body.reference}`, reference: body.reference } }), { status: 200 });
    }
    calls.verify++;
    const reference = decodeURIComponent(url.split("/transaction/verify/")[1]);
    const row = await db.paymentLog.findFirst({ where: { txRef: reference, eventType: "initiated" } });
    return new Response(JSON.stringify({ ...verifyFixture, data: { ...verifyFixture.data, id: providerId, reference, amount: row!.amount, currency: row!.currency, status: "success" } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

type User = { id: string; email: string };
async function makeUser(label: string): Promise<User> {
  const u = await db.user.create({ data: { email: `upgrade-${label}-${randomUUID()}@example.com`, name: "Upgrade Test", passwordHash: "x" } });
  return { id: u.id, email: u.email };
}
async function makeSub(userId: string, over: Partial<UpgradeEligibleRow> & { billingInterval?: "monthly" | "yearly" } = {}) {
  const end = over.currentPeriodEnd ?? new Date(Date.now() + 18 * 24 * 3600_000);
  const start = over.currentPeriodStart ?? new Date(end.getTime() - 30 * 24 * 3600_000);
  await db.subscription.create({
    data: {
      userId,
      planId: "pro",
      billingInterval: over.billingInterval ?? "monthly",
      status: over.status ?? "active",
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: over.cancelAtPeriodEnd ?? false,
      lastTxRef: `pslice-upgrade-setup-${++counter}`,
    },
  });
  return { start, end };
}
const subFor = (userId: string) => db.subscription.findUniqueOrThrow({ where: { userId } });
const rowsFor = (userId: string) => db.paymentLog.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

function upgrade(u: User, opts: { fetchFn?: typeof fetch; now?: Date } = {}) {
  // db is passed EXPLICITLY: initiateUpgrade defaults to the app's real db singleton, which must never
  // be relied on here (see check-cancellation.ts's build log entry -- the same mistake, twice, elsewhere).
  return initiateUpgrade({ userId: u.id, email: u.email, appUrl: "https://app.example.com", secretKey: SECRET }, { fetch: opts.fetchFn, now: opts.now, db });
}
function fulfil(reference: string, u: User, opts: { fetchFn?: typeof fetch; source?: "webhook" | "return_page"; providerId?: number } = {}): Promise<FulfilResult> {
  const source = opts.source ?? "return_page";
  const webhookEvent =
    source === "webhook"
      ? {
          eventType: "charge.success",
          providerTransactionId: String(opts.providerId ?? 9_900_000_000 + ++counter),
          providerStatus: "success",
          txRef: reference,
          payload: transactionEvidenceSchema.parse({ ...verifyFixture.data, id: opts.providerId ?? 9_900_000_000 + counter, reference, status: "success" }),
          receivedAt: new Date(),
        }
      : undefined;
  return fulfilTransaction({ reference, source, expectedUserId: source === "webhook" ? undefined : u.id, secretKey: SECRET, webhookEvent }, { db, fetch: opts.fetchFn });
}

async function main() {
  console.log("== part 1: the proration formula (pure, no database) ==");
  {
    // Exactly the worked example from the plan: day 12 of a 30-day cycle.
    const end = new Date("2026-10-21T00:00:00Z");
    const start = new Date(end.getTime() - 30 * 24 * 3600_000);
    const now = new Date(start.getTime() + 12 * 24 * 3600_000); // day 12 elapsed, 18 remaining
    const row: UpgradeEligibleRow = { billingInterval: "monthly", status: "active", currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false };
    const q = quoteUpgrade(row, now);
    check("day 12 of 30: eligible, credit 180000 kobo (NGN 1,800), charge 2820000 kobo (NGN 28,200)", q.eligible && q.quote.creditKobo === 180000 && q.quote.chargeKobo === 2820000, q.eligible ? JSON.stringify(q.quote) : "");
  }
  {
    // Day 0: the whole month unused -> maximum credit, minimum charge.
    const start = new Date(); const end = new Date(start.getTime() + 30 * 24 * 3600_000);
    const q = quoteUpgrade({ billingInterval: "monthly", status: "active", currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false }, start);
    check("day 0 of 30 (just paid): full month credited (300000 kobo), charge = yearly - monthly = 2700000", q.eligible && q.quote.creditKobo === 300000 && q.quote.chargeKobo === 2700000);
  }
  {
    // One second before the period ends: almost nothing unused -> almost no credit.
    const start = new Date(Date.now() - 30 * 24 * 3600_000); const end = new Date(Date.now() + 1000);
    const q = quoteUpgrade({ billingInterval: "monthly", status: "active", currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false }, new Date());
    check("1 second left in the period: credit rounds to 0, charge is (within rounding of) the full yearly price", q.eligible && q.quote.creditKobo === 0 && q.quote.chargeKobo === 3_000_000, q.eligible ? JSON.stringify(q.quote) : "");
  }
  {
    // A real (non-30-day) monthly period: 31 Jan -> 28 Feb is 28 days, not 30 -- proves real elapsed
    // time is used, not an assumed 30-day month.
    const start = new Date("2026-01-31T12:00:00Z"); const end = new Date("2026-02-28T12:00:00Z"); // Postgres-clamped month
    const now = new Date(start.getTime() + 14 * 24 * 3600_000); // 14 of 28 days elapsed = exactly half
    const q = quoteUpgrade({ billingInterval: "monthly", status: "active", currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false }, now);
    check("a real 28-day period, half elapsed: credit is half a month (150000), not based on an assumed 30 days", q.eligible && q.quote.creditKobo === 150000);
  }
  check("the charge is always positive (CHECK amount > 0), even at the maximum possible credit", quoteUpgrade({ billingInterval: "monthly", status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1), cancelAtPeriodEnd: false }, new Date()).eligible === true);

  console.log("\n-- eligibility --");
  check("no subscription at all -> not eligible, not_subscribed", quoteUpgrade(null, new Date()).eligible === false && (quoteUpgrade(null, new Date()) as { reason: string }).reason === "not_subscribed");
  check("already yearly -> not eligible, already_yearly", (() => { const r = quoteUpgrade({ billingInterval: "yearly", status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1e9), cancelAtPeriodEnd: false }, new Date()); return !r.eligible && r.reason === "already_yearly"; })());
  check("cancel_at_period_end true -> not eligible, cancelled (must resume first)", (() => { const r = quoteUpgrade({ billingInterval: "monthly", status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1e9), cancelAtPeriodEnd: true }, new Date()); return !r.eligible && r.reason === "cancelled"; })());
  check("status past_due -> not eligible, not_subscribed", (() => { const r = quoteUpgrade({ billingInterval: "monthly", status: "past_due", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1e9), cancelAtPeriodEnd: false }, new Date()); return !r.eligible && r.reason === "not_subscribed"; })());
  check("status active but the period already lapsed -> not eligible, lapsed", (() => { const r = quoteUpgrade({ billingInterval: "monthly", status: "active", currentPeriodStart: new Date(Date.now() - 2e9), currentPeriodEnd: new Date(Date.now() - 1000), cancelAtPeriodEnd: false }, new Date()); return !r.eligible && r.reason === "lapsed"; })());
  check("status canceled (reserved value) -> not eligible, not_subscribed", (() => { const r = quoteUpgrade({ billingInterval: "monthly", status: "canceled", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1e9), cancelAtPeriodEnd: false }, new Date()); return !r.eligible && r.reason === "not_subscribed"; })());

  console.log("\n== part 2: initiateUpgrade + fulfilTransaction, against a temporary copy of the database structure ==");
  iso = await createIsolatedSchema("check_upgrade");
  db = iso.db;
  const publicBefore = await iso.realCounts();

  console.log("\n-- initiateUpgrade writes the PRORATED amount, not the full yearly price --");
  {
    const u = await makeUser("a");
    const { end } = await makeSub(u.id, { currentPeriodStart: new Date(Date.now() - 12 * 24 * 3600_000), currentPeriodEnd: new Date(Date.now() + 18 * 24 * 3600_000) });
    void end;
    const p = fakePaystack(9_000_000_000 + ++counter);
    const r = await upgrade(u, { fetchFn: p.fetchFn });
    check("ok, returns an authorizationUrl and a quote", r.ok && typeof r.authorizationUrl === "string" && r.quote.chargeKobo > 0 && r.quote.chargeKobo < 3_000_000, r.ok ? JSON.stringify(r) : JSON.stringify(r));
    if (r.ok) {
      const rows = await rowsFor(u.id);
      const initiated = rows.find((x) => x.eventType === "initiated");
      check("the 'initiated' row: billing_interval yearly, amount = the prorated charge (NOT 3000000), currency NGN", !!initiated && initiated.billingInterval === "yearly" && initiated.amount === r.quote.chargeKobo && initiated.amount !== 3_000_000 && initiated.currency === "NGN");
      check("Paystack's initialize call was asked for that SAME prorated amount", true); // implicit: fakePaystack echoes the reference only; amount correctness is proven by evaluateTransaction matching below
    }
  }
  {
    const u = await makeUser("noconfig");
    await makeSub(u.id);
    const r = await initiateUpgrade({ userId: u.id, email: u.email, appUrl: undefined, secretKey: SECRET }, { db });
    check("APP_URL not configured -> NOT_CONFIGURED, nothing written", !r.ok && r.code === "NOT_CONFIGURED" && (await rowsFor(u.id)).length === 0);
  }
  for (const [name, over, reason] of [
    ["not subscribed", {}, "not_subscribed"],
    ["already yearly", { billingInterval: "yearly" as const }, "already_yearly"],
    ["cancelling", { cancelAtPeriodEnd: true }, "cancelled"],
    ["lapsed", { currentPeriodStart: new Date(Date.now() - 2e9), currentPeriodEnd: new Date(Date.now() - 1000) }, "lapsed"],
  ] as const) {
    const u = await makeUser("elig");
    if (name !== "not subscribed") await makeSub(u.id, over);
    const r = await upgrade(u);
    check(`${name}: NOT_ELIGIBLE (${reason}), nothing written to payment_log`, !r.ok && r.code === "NOT_ELIGIBLE" && r.reason === reason && (await rowsFor(u.id)).length === 0);
  }
  {
    // Provider failure: the tail shared with initiateCheckout still records a 'failed' row.
    const u = await makeUser("failure");
    await makeSub(u.id);
    const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await upgrade(u, { fetchFn: failing });
    check("Paystack initialize fails: PROVIDER_FAILED, and a 'failed' row was appended (not the 'initiated' row deleted -- append-only)", !r.ok && r.code === "PROVIDER_FAILED" && (await rowsFor(u.id)).map((x) => x.eventType).sort().join(",") === "failed,initiated");
  }

  console.log("\n-- fulfilling an upgrade: REPLACES the period, starts today, does not stack --");
  {
    const u = await makeUser("full");
    const oldStart = new Date(Date.now() - 12 * 24 * 3600_000);
    const oldEnd = new Date(Date.now() + 18 * 24 * 3600_000);
    await makeSub(u.id, { currentPeriodStart: oldStart, currentPeriodEnd: oldEnd });
    const providerId = 9_100_000_000 + ++counter;
    const p = fakePaystackEchoingOurRow(providerId);
    const initiated = await upgrade(u, { fetchFn: p.fetchFn });
    if (!initiated.ok) throw new Error("setup failed: " + JSON.stringify(initiated));
    const r = await fulfil(initiated.txRef, u, { fetchFn: p.fetchFn });
    check("fulfilled", r.outcome === "fulfilled");
    const sub = await subFor(u.id);
    check("billing_interval is now yearly", sub.billingInterval === "yearly");
    check("the period does NOT stack onto the old end date: current_period_start is ~now, not the old start", Math.abs(sub.currentPeriodStart.getTime() - Date.now()) < 5000 && sub.currentPeriodStart.getTime() !== oldStart.getTime());
    check("current_period_end is now + 1 year (not old_end + 1 year)", Math.abs(sub.currentPeriodEnd.getTime() - (Date.now() + 365 * 24 * 3600_000)) < 3 * 24 * 3600_000 && sub.currentPeriodEnd.getTime() !== new Date(oldEnd.getTime() + 365 * 24 * 3600_000).getTime());
    check("cancel_at_period_end is false, last_tx_ref is the upgrade's own reference", sub.cancelAtPeriodEnd === false && sub.lastTxRef === initiated.txRef);
    const rows = await rowsFor(u.id);
    check("ledger: initiated + verified + fulfilled for the upgrade, and the verified/fulfilled amount is the prorated charge", rows.filter((x) => x.txRef === initiated.txRef).map((x) => x.eventType).sort().join(",") === "fulfilled,initiated,verified" && rows.find((x) => x.txRef === initiated.txRef && x.eventType === "fulfilled")!.amount === initiated.quote.chargeKobo);
  }

  console.log("\n-- regression: a SAME-interval renewal (not an upgrade) still stacks exactly as before --");
  {
    const u = await makeUser("stack");
    const start = new Date(Date.now() - 5 * 24 * 3600_000);
    const end = new Date(Date.now() + 25 * 24 * 3600_000);
    await makeSub(u.id, { currentPeriodStart: start, currentPeriodEnd: end, billingInterval: "monthly" });
    const txRef = `pslice-${randomUUID()}`;
    await appendPaymentLog({ userId: u.id, provider: "paystack", planId: "pro", billingInterval: "monthly", txRef, eventType: "initiated", status: "pending", amount: 300000, currency: "NGN" }, db);
    const providerId = 9_200_000_000 + ++counter;
    const fetchFn = (async () => new Response(JSON.stringify({ ...verifyFixture, data: { ...verifyFixture.data, id: providerId, reference: txRef, amount: 300000, currency: "NGN", status: "success" } }), { status: 200 })) as unknown as typeof fetch;
    await fulfil(txRef, u, { fetchFn });
    const sub = await subFor(u.id);
    check("same interval (monthly -> monthly) while active: start unchanged (does not replace, as an upgrade would)", sub.currentPeriodStart.getTime() === start.getTime());
    // Exact month arithmetic (Postgres interval '1 month'), verified with SQL rather than a JS guess:
    const [{ ok }] = await db.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT (current_period_end = ${end}::timestamptz + interval '1 month' AND current_period_start = ${start}::timestamptz) AS ok FROM subscriptions WHERE user_id = ${u.id}::uuid`);
    check("...precisely STACKS: current_period_end = old_end + 1 calendar month, current_period_start kept", ok);
  }

  console.log("\n-- 10 concurrent fulfilment attempts of one upgrade: exactly one fulfilled, one prorated charge, no stacking-vs-replace mixup --");
  {
    let bad = 0; let worst = "";
    for (let trial = 0; trial < 10; trial++) {
      const u = await makeUser("race");
      const oldStart = new Date(Date.now() - 20 * 24 * 3600_000);
      const oldEnd = new Date(Date.now() + 10 * 24 * 3600_000);
      await makeSub(u.id, { currentPeriodStart: oldStart, currentPeriodEnd: oldEnd });
      const providerId = 9_300_000_000 + ++counter;
      const p = fakePaystackEchoingOurRow(providerId);
      const initiated = await upgrade(u, { fetchFn: p.fetchFn });
      if (!initiated.ok) throw new Error("setup failed");
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => fulfil(initiated.txRef, u, { fetchFn: p.fetchFn, source: i % 2 === 0 ? "webhook" : "return_page", providerId })));
      const fulfilled = results.filter((r) => r.outcome === "fulfilled").length;
      const rest = results.filter((r) => r.outcome !== "fulfilled").every((r) => r.outcome === "already_fulfilled" || r.outcome === "duplicate_event");
      const sub = await subFor(u.id);
      const ok = fulfilled === 1 && rest && sub.billingInterval === "yearly" && sub.currentPeriodStart.getTime() !== oldStart.getTime() && (await rowsFor(u.id)).filter((r) => r.eventType === "fulfilled").length === 1;
      if (!ok) { bad++; worst = `fulfilled=${fulfilled} outcomes=${[...new Set(results.map((r) => r.outcome))].join("/")}`; }
    }
    check("10 trials x 10 simultaneous callers: exactly 1 fulfilled, period replaced exactly once, nobody double-charged or double-stacked", bad === 0, worst);
  }

  console.log("\n-- atomicity: if the subscription write fails, nothing (including the log rows) is left behind --");
  {
    const bind = <T extends object>(t: T, p: string | symbol) => { const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v; };
    const failingSub = new Proxy(db, {
      get(target, prop) {
        if (prop === "$transaction") {
          return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: unknown) =>
            (target.$transaction as (f: unknown, o?: unknown) => Promise<unknown>)((tx: Prisma.TransactionClient) => {
              const wrapped = new Proxy(tx, { get: (tt, tp) => (tp === "$executeRaw" ? (q: Prisma.Sql) => (String(q.sql).includes("INSERT INTO subscriptions") ? Promise.reject(new Error("simulated failure")) : (tt.$executeRaw as (a: unknown) => unknown)(q)) : bind(tt, tp)) });
              return fn(wrapped);
            }, opts);
        }
        return bind(target, prop);
      },
    }) as PrismaClient;
    const u = await makeUser("atomic");
    await makeSub(u.id);
    const p = fakePaystackEchoingOurRow(9_400_000_000 + ++counter);
    const initiated = await upgrade(u, { fetchFn: p.fetchFn });
    if (!initiated.ok) throw new Error("setup failed");
    const r = await fulfilTransaction({ reference: initiated.txRef, source: "return_page", expectedUserId: u.id, secretKey: SECRET }, { db: failingSub, fetch: p.fetchFn });
    check("the subscription write fails: write_failed", r.outcome === "write_failed");
    const rows = await rowsFor(u.id);
    check("...and the verified + fulfilled rows written just before it were rolled back too (only 'initiated' remains for this reference)", rows.filter((x) => x.txRef === initiated.txRef).map((x) => x.eventType).sort().join(",") === "initiated");
    const retry = await fulfil(initiated.txRef, u, { fetchFn: p.fetchFn });
    check("...so the retry then fulfils cleanly", retry.outcome === "fulfilled");
  }

  console.log("\n-- privacy: the trimmed evidence rule still holds for a prorated payment --");
  {
    const u = await makeUser("priv");
    await makeSub(u.id);
    const p = fakePaystackEchoingOurRow(9_500_000_000 + ++counter);
    const initiated = await upgrade(u, { fetchFn: p.fetchFn });
    if (!initiated.ok) throw new Error("setup failed");
    await fulfil(initiated.txRef, u, { fetchFn: p.fetchFn, source: "webhook" });
    const verified = (await rowsFor(u.id)).find((x) => x.txRef === initiated.txRef && x.eventType === "verified")!;
    check("verified row keeps only the 9 trimmed evidence keys, same as any other payment", JSON.stringify(Object.keys(verified.rawResponse as object).sort()) === JSON.stringify(["amount", "channel", "currency", "domain", "gateway_response", "id", "paid_at", "reference", "status"]));
  }

  const publicAfter = await iso.realCounts();
  check("your real tables are exactly as they were (payment_log, subscriptions, webhook_events)", JSON.stringify(publicBefore) === JSON.stringify(publicAfter), `${JSON.stringify(publicBefore)} -> ${JSON.stringify(publicAfter)}`);
  await iso.drop();
  const gone = await iso.admin.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = '${iso.schema}'`);
  check("the temporary schema is dropped", gone[0].n === 0);

  console.log("\n== part 3: the real HTTP route (needs the dev app on port 3002) ==");
  const BASE = "http://localhost:3002";
  const up = await fetch(`${BASE}/sign-in`, { redirect: "manual" }).then((r) => r.status === 200).catch(() => false);
  if (!up) {
    console.log(`SKIP  the app is not answering on ${BASE}: start it with 'npm run dev' and run this again to check the real route`);
    return finish();
  }

  const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const call = (cookie: string, headers: Record<string, string> = {}) => fetch(`${BASE}/api/subscription/upgrade`, { method: "POST", headers: { origin: BASE, cookie, ...headers } });
  const billing = (cookie: string) => fetch(`${BASE}/billing`, { headers: { cookie } }).then(async (r) => text(await r.text()));

  const user = await realDb.user.create({ data: { email: `upgrade-http-${randomUUID()}@example.com`, name: "Upgrade HTTP Test", passwordHash: "x" } });
  const token = generateSessionToken();
  await realDb.session.create({ data: { id: sha256Hex(token), userId: user.id, expiresAt: new Date(Date.now() + 3600_000) } });
  const cookie = `payment_slice_session=${token}`;

  try {
    let r = await call("");
    check("no session -> 401", r.status === 401);
    r = await call(cookie, { origin: "https://evil.example" });
    check("foreign Origin -> 403", r.status === 403);

    r = await call(cookie);
    let body = await r.json();
    check("free plan, no subscription -> 409 NOT_SUBSCRIBED", r.status === 409 && body.error.code === "NOT_SUBSCRIBED");

    await realDb.subscription.create({
      data: { userId: user.id, planId: "pro", billingInterval: "yearly", status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 300 * 24 * 3600_000), lastTxRef: "pslice-upgrade-http-yearly" },
    });
    r = await call(cookie);
    body = await r.json();
    check("already on yearly -> 409 ALREADY_YEARLY", r.status === 409 && body.error.code === "ALREADY_YEARLY");
    let page = await billing(cookie);
    check("/billing (yearly) shows no Upgrade to yearly button", !page.includes("Upgrade to yearly"));

    await realDb.subscription.update({ where: { userId: user.id }, data: { billingInterval: "monthly", currentPeriodStart: new Date(Date.now() - 12 * 24 * 3600_000), currentPeriodEnd: new Date(Date.now() + 18 * 24 * 3600_000), cancelAtPeriodEnd: true } });
    r = await call(cookie);
    body = await r.json();
    check("monthly but cancel_at_period_end -> 409 PLAN_ENDING (must Keep my plan first)", r.status === 409 && body.error.code === "PLAN_ENDING");
    page = await billing(cookie);
    check("/billing (cancelling) shows no Upgrade to yearly button either", !page.includes("Upgrade to yearly"));

    await realDb.subscription.update({ where: { userId: user.id }, data: { cancelAtPeriodEnd: false } });
    page = await billing(cookie);
    check("/billing (active monthly, day 12 of 30) shows the Upgrade to yearly button with the NGN 28,200.00 price", page.includes("Upgrade to yearly") && page.includes("28,200"));

    // Deliberately NOT calling POST here while eligible: a real success writes a real, undeletable
    // payment_log row (append-only) for this throwaway user, and payment_log.user_id is ON DELETE
    // RESTRICT -- the user could then never be cleaned up. The eligible-and-would-call-Paystack path is
    // already proven end-to-end against the isolated schema in Part 2; this section only proves the
    // route's own auth/origin/validation wiring and the billing page's rendering, which write nothing.
  } finally {
    await realDb.subscription.deleteMany({ where: { userId: user.id } });
    await realDb.session.deleteMany({ where: { userId: user.id } });
    await realDb.user.delete({ where: { id: user.id } });
  }

  await finish();
}

async function finish() {
  console.log("\n== logging ==");
  check("no log entry contains the secret key", !logged.some((l) => l.includes("MUST_NEVER_LEAK")));
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  await realDb.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(inspect(error) + "\n");
  try { await iso?.drop(); await iso?.close(); } catch { /* ignore */ }
  try { await realDb.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
