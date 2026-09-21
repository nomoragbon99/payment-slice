// Proves fulfilTransaction() against the REAL database structure, with a FAKE Paystack.
//
// payment_log rows can never be deleted (append-only trigger), and a concurrency test needs rows that are
// really committed. So this script creates a TEMPORARY Postgres schema, runs the project's real migrations
// into it (real tables, real CHECKs, real partial unique indexes, real append-only trigger), runs everything
// there, and always drops that schema at the end. It never writes to your real tables (public.*): it checks
// the row counts before and after. It refuses to run against a non-local database.
//
// Run with: npm run check:fulfilment
// (the temporary-schema harness itself lives in scripts/lib/isolated-schema.ts)
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { inspect } from "util";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { fulfilTransaction, type FulfilResult, type FulfilSource, type WebhookEventInput } from "../src/lib/checkout/fulfil";
import { appendPaymentLog } from "../src/lib/payment-log";
import { transactionEvidenceSchema } from "../src/lib/paystack/evidence";
import { createIsolatedSchema, type Isolated } from "./lib/isolated-schema";

// The code under test logs warnings and errors: capture them so we can prove they never contain secrets
// or card details, instead of printing hundreds of lines.
const logged: string[] = [];
const capture = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4 }))).join(" ")); };
console.error = capture;
console.warn = capture;

let iso: Isolated | undefined;
let db!: PrismaClient;
let admin!: PrismaClient;
let schema = "";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

const SECRET = "sk_test_THIS_MUST_NEVER_LEAK";
const verifyFixture = JSON.parse(readFileSync(join(process.cwd(), "scripts", "fixtures", "paystack", "verify-success.json"), "utf8"));
const SENSITIVE_VALUES = ["AUTH_FAKE_0000", "SIG_FAKE_0000", "customer@example.com", "CUS_fake0000", "203.0.113.10"];
const SENSITIVE_KEYS = ["authorization", "authorization_code", "customer", "email", "last4", "signature", "ip_address", "metadata", "fees"];
const EVIDENCE_KEYS = ["amount", "channel", "currency", "domain", "gateway_response", "id", "paid_at", "reference", "status"];

// ---------- helpers ----------
type User = { id: string; email: string };
type Order = { user: User; txRef: string; interval: "monthly" | "yearly"; amount: number; providerId: number };
let counter = 0;

async function makeUser(label: string): Promise<User> {
  const u = await db.user.create({ data: { email: `fulfil-${label}-${randomUUID()}@example.com`, name: "Fulfil Test", passwordHash: "x" } });
  return { id: u.id, email: u.email };
}
async function makeOrder(user: User, opts: { interval?: "monthly" | "yearly"; amount?: number } = {}): Promise<Order> {
  const interval = opts.interval ?? "monthly";
  const amount = opts.amount ?? (interval === "monthly" ? 300000 : 3000000);
  const txRef = `pslice-${randomUUID()}`;
  await appendPaymentLog({ userId: user.id, provider: "paystack", planId: "pro", billingInterval: interval, txRef, eventType: "initiated", status: "pending", amount, currency: "NGN" }, db);
  return { user, txRef, interval, amount, providerId: 7_000_000_000 + ++counter };
}

// A fake Paystack /transaction/verify/{reference}: a full, realistic reply (card and customer objects included).
function paystackReply(o: Order, over: Record<string, unknown> = {}) {
  return () => new Response(JSON.stringify({ ...verifyFixture, data: { ...verifyFixture.data, id: o.providerId, reference: o.txRef, amount: o.amount, currency: "NGN", status: "success", ...over } }), { status: 200 });
}
function fakePaystack(respond: () => Response | Promise<Response>) {
  const state = { calls: 0 };
  const fetchFn = (async () => { state.calls++; return respond(); }) as unknown as typeof fetch;
  return { fetchFn, state };
}
const raw = (status: number, body: unknown) => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function webhookEventFor(o: Order, over: Partial<WebhookEventInput> = {}): WebhookEventInput {
  return {
    eventType: "charge.success", providerTransactionId: String(o.providerId), providerStatus: "success", txRef: o.txRef,
    payload: transactionEvidenceSchema.parse({ ...verifyFixture.data, id: o.providerId, reference: o.txRef, amount: o.amount, currency: "NGN", status: "success" }),
    ...over,
  };
}

type CallOpts = { source?: FulfilSource; fetchFn?: typeof fetch; asUser?: string | null; secretKey?: string | undefined; event?: WebhookEventInput; now?: Date; client?: PrismaClient; reference?: string };
function fulfil(o: Order, opts: CallOpts = {}): Promise<FulfilResult> {
  const source = opts.source ?? "return_page";
  return fulfilTransaction(
    {
      reference: opts.reference ?? o.txRef,
      source,
      expectedUserId: source === "return_page" ? (opts.asUser === undefined ? o.user.id : opts.asUser ?? undefined) : undefined,
      secretKey: "secretKey" in opts ? opts.secretKey : SECRET,
      webhookEvent: source === "webhook" ? (opts.event ?? webhookEventFor(o)) : undefined,
    },
    { db: opts.client ?? db, fetch: opts.fetchFn, now: opts.now },
  );
}

const rowsFor = (txRef: string) => db.paymentLog.findMany({ where: { txRef }, orderBy: { createdAt: "asc" } });
const typesOf = async (txRef: string) => (await rowsFor(txRef)).map((r) => r.eventType).sort().join(",");
const eventsFor = (txRef: string) => db.webhookEvent.findMany({ where: { txRef } });
const subFor = (userId: string) => db.subscription.findUnique({ where: { userId } });
const countLog = (where: Prisma.PaymentLogWhereInput) => db.paymentLog.count({ where });
async function sqlBool(query: Prisma.Sql): Promise<boolean> { return (await db.$queryRaw<{ ok: boolean }[]>(query))[0].ok; }
async function textOf(query: Prisma.Sql): Promise<string> { return (await db.$queryRaw<{ v: string }[]>(query))[0].v; }

// Wraps the client so every transaction can be tampered with, to simulate failures and to switch protections off.
type TxTamper = { failOn?: (sql: string) => boolean; skipLock?: boolean; recheckAlwaysZero?: boolean; failWebhookUpsert?: boolean; fulfilledInserts?: { n: number } };
function tampered(client: PrismaClient, t: TxTamper): PrismaClient {
  const bind = <T extends object>(target: T, prop: string | symbol) => {
    const v = Reflect.get(target, prop);
    return typeof v === "function" ? v.bind(target) : v;
  };
  const wrapTx = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === "$queryRaw") {
          return (strings: TemplateStringsArray, ...values: unknown[]) =>
            t.skipLock && strings.join("?").includes("pg_advisory_xact_lock") ? Promise.resolve([{ locked: 1 }]) : (target.$queryRaw as (...a: unknown[]) => unknown)(strings, ...values);
        }
        if (prop === "$executeRaw") {
          return (query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
            const sql = Array.isArray(query) ? (query as unknown as string[]).join("?") : (query as Prisma.Sql).sql;
            if (t.failOn?.(sql)) return Promise.reject(new Error("simulated database failure"));
            return (target.$executeRaw as (...a: unknown[]) => unknown)(query, ...values);
          };
        }
        if (prop === "paymentLog" && (t.recheckAlwaysZero || t.fulfilledInserts)) {
          return new Proxy(target.paymentLog, {
            get: (pt, pp) => {
              if (pp === "count" && t.recheckAlwaysZero) return async () => 0;
              // Counts how many callers actually got as far as INSERTING a 'fulfilled' row.
              if (pp === "create" && t.fulfilledInserts) {
                return (args: { data: { eventType?: string } }) => {
                  if (args?.data?.eventType === "fulfilled") t.fulfilledInserts!.n++;
                  return (pt.create as (a: unknown) => unknown)(args);
                };
              }
              return bind(pt, pp);
            },
          });
        }
        if (prop === "webhookEvent" && t.failWebhookUpsert) {
          return new Proxy(target.webhookEvent, { get: (wt, wp) => (wp === "upsert" ? () => Promise.reject(new Error("simulated database failure")) : bind(wt, wp)) });
        }
        return bind(target, prop);
      },
    });
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "$transaction") {
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: unknown) =>
          (target.$transaction as (f: unknown, o?: unknown) => Promise<unknown>)((tx: Prisma.TransactionClient) => fn(wrapTx(tx)), opts);
      }
      return bind(target, prop);
    },
  });
}

// ---------- the tests ----------
async function main() {
  iso = await createIsolatedSchema("check_fulfilment");
  db = iso.db;
  admin = iso.admin;
  schema = iso.schema;
  const publicBefore = await iso.realCounts();

  console.log("== harness: a real, isolated copy of the database structure ==");
  // (createIsolatedSchema has already stopped everything unless raw SQL and model queries both resolve to the temporary schema.)
  check("raw SQL resolves to the temporary schema, not public (current_schema, subscriptions, payment_log)", true, `${iso.proof.currentSchema} / ${iso.proof.rawSubscriptions} / ${iso.proof.rawPaymentLog}`);
  check("Prisma's model queries hit the temporary schema too (its user table is empty; public has real users)", iso.proof.temporaryUsers === 0 && iso.proof.realUsers > 0, `temporary=${iso.proof.temporaryUsers}, public=${iso.proof.realUsers}`);
  const trig = await admin.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = '${schema}' AND c.relname = 'payment_log' AND t.tgname = 'payment_log_append_only'`);
  check("the real append-only trigger exists in it", trig[0].n === 1);
  const idx = await admin.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = '${schema}' AND indexname IN ('payment_log_one_fulfilment_per_tx_ref','payment_log_one_fulfilment_per_provider_id')`);
  check("the real one-fulfilment-per-transaction unique indexes exist in it", idx[0].n === 2);

  console.log("\n== a successful payment through the return page ==");
  {
    const u = await makeUser("a"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o));
    const r = await fulfil(o, { fetchFn: p.fetchFn });
    check("outcome: fulfilled", r.outcome === "fulfilled");
    check("Paystack was asked exactly once", p.state.calls === 1);
    check("ledger: initiated + verified + fulfilled, nothing else", (await typesOf(o.txRef)) === "fulfilled,initiated,verified");
    const rows = await rowsFor(o.txRef);
    const verified = rows.find((x) => x.eventType === "verified")!;
    const fulfilled = rows.find((x) => x.eventType === "fulfilled")!;
    check("verified row: successful, provider id, amount and currency as Paystack reported", verified.status === "successful" && verified.providerTransactionId === String(o.providerId) && verified.amount === 300000 && verified.currency === "NGN" && verified.provider === "paystack");
    check("verified row keeps only the 9 evidence keys", JSON.stringify(Object.keys(verified.rawResponse as object).sort()) === JSON.stringify(EVIDENCE_KEYS));
    check("fulfilled row: successful, same provider id, records the source", fulfilled.status === "successful" && fulfilled.providerTransactionId === String(o.providerId) && (fulfilled.rawResponse as { source: string }).source === "return_page");
    const sub = await subFor(u.id);
    check("subscription: pro, monthly, active, not cancelling, no reason, last_tx_ref = this payment", !!sub && sub.planId === "pro" && sub.billingInterval === "monthly" && sub.status === "active" && sub.cancelAtPeriodEnd === false && sub.cancellationReason === null && sub.lastTxRef === o.txRef);
    check("subscription period is exactly one calendar month", await sqlBool(Prisma.sql`SELECT (current_period_end = current_period_start + interval '1 month') AS ok FROM subscriptions WHERE user_id = ${u.id}::uuid`));
    check("the subscription starts now (database clock, within 30 s)", await sqlBool(Prisma.sql`SELECT (abs(extract(epoch FROM (clock_timestamp() - current_period_start))) < 30) AS ok FROM subscriptions WHERE user_id = ${u.id}::uuid`));
  }
  {
    const u = await makeUser("y"); const o = await makeOrder(u, { interval: "yearly" });
    await fulfil(o, { fetchFn: fakePaystack(paystackReply(o)).fetchFn });
    check("yearly: 3000000 kobo and a period of exactly one calendar year", (await subFor(u.id))?.billingInterval === "yearly" && (await sqlBool(Prisma.sql`SELECT (current_period_end = current_period_start + interval '1 year') AS ok FROM subscriptions WHERE user_id = ${u.id}::uuid`)) && (await rowsFor(o.txRef)).find((x) => x.eventType === "fulfilled")?.amount === 3000000);
  }
  {
    const u1 = await makeUser("m1"); const o1 = await makeOrder(u1);
    await fulfil(o1, { fetchFn: fakePaystack(paystackReply(o1)).fetchFn, now: new Date("2026-01-31T12:00:00Z") });
    check("31 January + 1 month = 28 February (Postgres clamps month ends)", (await textOf(Prisma.sql`SELECT to_char(current_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS v FROM subscriptions WHERE user_id = ${u1.id}::uuid`)) === "2026-02-28T12:00");
    const u2 = await makeUser("m2"); const o2 = await makeOrder(u2, { interval: "yearly" });
    await fulfil(o2, { fetchFn: fakePaystack(paystackReply(o2)).fetchFn, now: new Date("2028-02-29T00:00:00Z") });
    check("29 Feb 2028 + 1 year = 28 Feb 2029", (await textOf(Prisma.sql`SELECT to_char(current_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS v FROM subscriptions WHERE user_id = ${u2.id}::uuid`)) === "2029-02-28");
  }

  console.log("\n== calling it again: nothing more happens ==");
  {
    const u = await makeUser("r"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o));
    await fulfil(o, { fetchFn: p.fetchFn });
    const before = await subFor(u.id);
    const again = await fulfil(o, { fetchFn: p.fetchFn });
    check("second call: already_fulfilled", again.outcome === "already_fulfilled");
    check("no second Paystack call (our ledger already records the verification)", p.state.calls === 1);
    check("no new ledger rows and the subscription is untouched", (await typesOf(o.txRef)) === "fulfilled,initiated,verified" && (await subFor(u.id))?.updatedAt.getTime() === before?.updatedAt.getTime());
  }

  console.log("\n== the webhook path, and the two callers in either order ==");
  {
    const u = await makeUser("w"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o));
    const r = await fulfil(o, { source: "webhook", fetchFn: p.fetchFn });
    check("webhook: fulfilled (after our own verification call, not on the webhook's say-so)", r.outcome === "fulfilled" && p.state.calls === 1);
    const ev = await eventsFor(o.txRef);
    check("webhook_events: one row, outcome fulfilled, processed_at set", ev.length === 1 && ev[0].outcome === "fulfilled" && ev[0].processedAt !== null && ev[0].provider === "paystack" && ev[0].eventType === "charge.success" && ev[0].providerStatus === "success");
    check("webhook_events.payload is the trimmed evidence (9 keys), not the body", JSON.stringify(Object.keys(ev[0].payload as object).sort()) === JSON.stringify(EVIDENCE_KEYS));
    const dup = await fulfil(o, { source: "webhook", fetchFn: p.fetchFn });
    check("the same delivery again: duplicate_event, no Paystack call, no new rows", dup.outcome === "duplicate_event" && p.state.calls === 1 && (await eventsFor(o.txRef)).length === 1 && (await typesOf(o.txRef)) === "fulfilled,initiated,verified");
    const page = await fulfil(o, { fetchFn: p.fetchFn });
    check("the page AFTER the webhook: already_fulfilled, no Paystack call", page.outcome === "already_fulfilled" && p.state.calls === 1);
  }
  {
    const u = await makeUser("pw"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o));
    const page = await fulfil(o, { fetchFn: p.fetchFn });
    const hook = await fulfil(o, { source: "webhook", fetchFn: p.fetchFn });
    check("the page FIRST, then the webhook: fulfilled, then already_fulfilled", page.outcome === "fulfilled" && hook.outcome === "already_fulfilled");
    const ev = await eventsFor(o.txRef);
    check("...the webhook is still recorded (outcome already_fulfilled) and the ledger is not doubled", ev.length === 1 && ev[0].outcome === "already_fulfilled" && (await typesOf(o.txRef)) === "fulfilled,initiated,verified" && p.state.calls === 1);
  }

  console.log("\n== both callers at the same moment: exactly one fulfilment ==");
  {
    let worst = "";
    const TRIALS = 10; const CALLERS = 20; let bad = 0; let paystackCalls = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const u = await makeUser("c"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o));
      const results = await Promise.all(Array.from({ length: CALLERS }, (_, i) => fulfil(o, { source: i % 2 === 0 ? "webhook" : "return_page", fetchFn: p.fetchFn })));
      paystackCalls += p.state.calls;
      const fulfilled = results.filter((r) => r.outcome === "fulfilled").length;
      const others = results.filter((r) => r.outcome !== "fulfilled").every((r) => r.outcome === "already_fulfilled" || r.outcome === "duplicate_event");
      const rows = await rowsFor(o.txRef);
      const sub = await subFor(u.id);
      const okTrial = fulfilled === 1 && others && rows.filter((r) => r.eventType === "fulfilled").length === 1 && rows.filter((r) => r.eventType === "verified").length === 1 && (await eventsFor(o.txRef)).length === 1 && !!sub && (await sqlBool(Prisma.sql`SELECT (current_period_end = current_period_start + interval '1 month') AS ok FROM subscriptions WHERE user_id = ${u.id}::uuid`));
      if (!okTrial) { bad++; worst = `fulfilled=${fulfilled} results=${[...new Set(results.map((r) => r.outcome))].join("/")}`; }
    }
    check(`${TRIALS} trials x ${CALLERS} simultaneous callers (10 webhook deliveries + 10 page visits each): exactly 1 fulfilled, 1 verified row, 1 event row, ONE month of subscription, nobody errored`, bad === 0, bad ? worst : `Paystack was asked ${paystackCalls} times in total`);
  }

  console.log("\n== defence in depth: switch the lock and the re-check OFF, the database still refuses a double fulfilment ==");
  {
    let bad = 0; let worst = ""; let mostAttempts = 0; let trialsWithMany = 0;
    for (let trial = 0; trial < 10; trial++) {
      const u = await makeUser("d"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o));
      const inserts = { n: 0 };
      const weak = tampered(db, { skipLock: true, recheckAlwaysZero: true, fulfilledInserts: inserts });
      const results = await Promise.all(Array.from({ length: 20 }, () => fulfil(o, { fetchFn: p.fetchFn, client: weak })));
      mostAttempts = Math.max(mostAttempts, inserts.n); if (inserts.n > 1) trialsWithMany++;
      const fulfilledRows = await countLog({ txRef: o.txRef, eventType: "fulfilled" });
      const ok = fulfilledRows === 1 && (await countLog({ txRef: o.txRef, eventType: "verified" })) === 1 && (await db.subscription.count({ where: { userId: u.id } })) === 1 && results.filter((r) => r.outcome === "fulfilled").length === 1 && results.every((r) => r.outcome === "fulfilled" || r.outcome === "already_fulfilled");
      if (!ok) { bad++; worst = `fulfilled rows=${fulfilledRows} outcomes=${[...new Set(results.map((r) => r.outcome))].join("/")}`; }
    }
    check("with NO lock and NO re-check, 20 racers x 10 trials: still exactly 1 fulfilled row, 1 verified row and 1 subscription (losers rolled back whole)", bad === 0, worst);
    check("...and the protections really were off: several callers reached the 'fulfilled' insert, so it was the unique index that stopped them", trialsWithMany > 0 && mostAttempts > 1, `callers reaching the insert: up to ${mostAttempts} of 20; ${trialsWithMany} of 10 trials had more than one`);
    {
      // The same race with the protections ON: exactly one caller ever reaches the insert.
      let maxWith = 0;
      for (let trial = 0; trial < 10; trial++) {
        const u = await makeUser("dl"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o));
        const inserts = { n: 0 };
        await Promise.all(Array.from({ length: 20 }, () => fulfil(o, { fetchFn: p.fetchFn, client: tampered(db, { fulfilledInserts: inserts }) })));
        maxWith = Math.max(maxWith, inserts.n);
      }
      check("(control) with the lock and the re-check ON, only ONE of 20 callers ever reaches the insert, in every trial", maxWith === 1, `most callers reaching the insert in any trial: ${maxWith}`);
    }
    const u = await makeUser("d2"); const a = await makeOrder(u); const b = await makeOrder(u);
    const same = 7_100_000_000 + ++counter;
    await appendPaymentLog({ userId: u.id, provider: "paystack", planId: "pro", billingInterval: "monthly", txRef: a.txRef, providerTransactionId: String(same), eventType: "fulfilled", status: "successful", amount: 300000, currency: "NGN" }, db);
    const errs: string[] = [];
    await appendPaymentLog({ userId: u.id, provider: "paystack", planId: "pro", billingInterval: "monthly", txRef: b.txRef, providerTransactionId: String(same), eventType: "fulfilled", status: "successful", amount: 300000, currency: "NGN" }, db).catch((e) => errs.push(String(e.code ?? e.message)));
    check("the same provider transaction id cannot be fulfilled under a second reference either", errs.length === 1, errs[0]);
  }

  console.log("\n== a second payment while already subscribed extends the period ==");
  {
    const u = await makeUser("s"); const o1 = await makeOrder(u); const o2 = await makeOrder(u, { interval: "yearly" });
    await fulfil(o1, { fetchFn: fakePaystack(paystackReply(o1)).fetchFn });
    const first = await subFor(u.id);
    const r2 = await fulfil(o2, { fetchFn: fakePaystack(paystackReply(o2)).fetchFn });
    const second = await subFor(u.id);
    check("second payment (yearly) while active: fulfilled", r2.outcome === "fulfilled");
    check("one subscription row; the start is kept; the end moves out by exactly one year; interval and last_tx_ref updated", (await db.subscription.count({ where: { userId: u.id } })) === 1 && second?.currentPeriodStart.getTime() === first?.currentPeriodStart.getTime() && (await sqlBool(Prisma.sql`SELECT (current_period_end = (SELECT current_period_end FROM subscriptions WHERE user_id = ${u.id}::uuid) AND current_period_end = current_period_start + interval '1 month' + interval '1 year') AS ok FROM subscriptions WHERE user_id = ${u.id}::uuid`)) && second?.billingInterval === "yearly" && second?.lastTxRef === o2.txRef);
    check("two fulfilled rows, one per payment: nobody's money is lost", (await countLog({ userId: u.id, eventType: "fulfilled" })) === 2);
  }
  {
    let bad = 0; let worst = "";
    for (let trial = 0; trial < 10; trial++) {
      const u = await makeUser("t"); const o1 = await makeOrder(u); const o2 = await makeOrder(u);
      const rs = await Promise.all([fulfil(o1, { fetchFn: fakePaystack(paystackReply(o1)).fetchFn }), fulfil(o2, { source: "webhook", fetchFn: fakePaystack(paystackReply(o2)).fetchFn })]);
      const ok = rs.every((r) => r.outcome === "fulfilled") && (await db.subscription.count({ where: { userId: u.id } })) === 1 && (await sqlBool(Prisma.sql`SELECT (current_period_end = current_period_start + interval '2 months') AS ok FROM subscriptions WHERE user_id = ${u.id}::uuid`));
      if (!ok) { bad++; worst = rs.map((r) => r.outcome).join("/"); }
    }
    check("two DIFFERENT payments for one person at the same moment (two tabs), 10 trials: both fulfilled, one subscription, exactly two months", bad === 0, worst);
  }

  console.log("\n== not currently subscribed: a fresh period, old cancellation cleared ==");
  for (const [name, status, endOffset, cancelling] of [["canceled (with time left)", "canceled", "+10 days", true], ["active but the period already ended", "active", "-2 days", false], ["past_due", "past_due", "+5 days", false]] as const) {
    const u = await makeUser("n"); const o = await makeOrder(u);
    await db.$executeRaw(Prisma.sql`INSERT INTO subscriptions (user_id, plan_id, billing_interval, status, current_period_start, current_period_end, cancel_at_period_end, cancellation_reason, last_tx_ref, updated_at)
      VALUES (${u.id}::uuid, 'pro', 'yearly', ${status}, now() - interval '30 days', now() + ${endOffset}::interval, ${cancelling}, ${cancelling ? "too expensive" : null}, 'pslice-old', now())`);
    await fulfil(o, { fetchFn: fakePaystack(paystackReply(o)).fetchFn });
    const sub = await subFor(u.id);
    check(`${name}: new period starting now (not stacked), active, cancellation cleared, interval and last_tx_ref updated`, !!sub && sub.status === "active" && sub.cancelAtPeriodEnd === false && sub.cancellationReason === null && sub.billingInterval === "monthly" && sub.lastTxRef === o.txRef && (await sqlBool(Prisma.sql`SELECT (current_period_end = current_period_start + interval '1 month' AND abs(extract(epoch FROM (clock_timestamp() - current_period_start))) < 30) AS ok FROM subscriptions WHERE user_id = ${u.id}::uuid`)));
  }

  console.log("\n== paid, but not the order we recorded: mismatch, nothing activated ==");
  for (const [name, over, field] of [["1 kobo short", { amount: 299999 }, "amount"], ["the yearly amount on a monthly order", { amount: 3000000 }, "amount"], ["a different currency", { currency: "USD" }, "currency"], ["Paystack answers for a different reference", { reference: `pslice-${randomUUID()}` }, "reference"]] as const) {
    const u = await makeUser("x"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o, over));
    const r = await fulfil(o, { fetchFn: p.fetchFn });
    check(`${name}: mismatch (${field}), no subscription, no fulfilled row`, r.outcome === "mismatch" && r.field === field && !(await subFor(u.id)) && (await countLog({ txRef: o.txRef, eventType: "fulfilled" })) === 0);
    await fulfil(o, { fetchFn: p.fetchFn }); await fulfil(o, { fetchFn: p.fetchFn });
    const failed = (await rowsFor(o.txRef)).filter((x) => x.eventType === "failed");
    check(`   (${name}) three visits leave exactly ONE 'failed' row, holding the reason and the trimmed evidence`, failed.length === 1 && (failed[0].rawResponse as { reason: string; field: string }).reason === "mismatch" && (failed[0].rawResponse as { field: string }).field === field && !JSON.stringify(failed[0].rawResponse).includes("AUTH_FAKE"));
  }
  {
    const u = await makeUser("xw"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o, { amount: 299999 }));
    const r = await fulfil(o, { source: "webhook", fetchFn: p.fetchFn });
    const again = await fulfil(o, { source: "webhook", fetchFn: p.fetchFn });
    const ev = await eventsFor(o.txRef);
    check("webhook + mismatch: recorded as amount_mismatch (once), redelivery is a duplicate", r.outcome === "mismatch" && ev.length === 1 && ev[0].outcome === "amount_mismatch" && again.outcome === "duplicate_event");
    const u2 = await makeUser("xc"); const o2 = await makeOrder(u2);
    const rs = await Promise.all(Array.from({ length: 10 }, () => fulfil(o2, { fetchFn: fakePaystack(paystackReply(o2, { amount: 1 })).fetchFn })));
    check("10 simultaneous visits of a mismatched payment: still one 'failed' row", rs.every((x) => x.outcome === "mismatch") && (await countLog({ txRef: o2.txRef, eventType: "failed" })) === 1);
  }

  console.log("\n== not paid (yet): nothing is written, and it can still be paid later ==");
  for (const [status, expected] of [["abandoned", "abandoned"], ["failed", "failed"], ["reversed", "reversed"], ["ongoing", "other"], ["pending", "other"], ["SUCCESS", "other"]] as const) {
    const u = await makeUser("np"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o, { status }));
    const r = await fulfil(o, { fetchFn: p.fetchFn });
    await fulfil(o, { fetchFn: p.fetchFn });
    check(`status ${JSON.stringify(status)}: not_paid (${expected}); no rows, no subscription; asked Paystack both times`, r.outcome === "not_paid" && r.paystackStatus === expected && (await typesOf(o.txRef)) === "initiated" && !(await subFor(u.id)) && p.state.calls === 2);
  }
  {
    // What really happened in the live test: a card was DECLINED, then the same reference was PAID hours later.
    const u = await makeUser("late"); const o = await makeOrder(u);
    const first = await fulfil(o, { fetchFn: fakePaystack(paystackReply(o, { status: "failed" })).fetchFn });
    const later = await fulfil(o, { fetchFn: fakePaystack(paystackReply(o)).fetchFn });
    check("declined first, then paid on the SAME reference later (as in the real test): the later payment is fulfilled", first.outcome === "not_paid" && later.outcome === "fulfilled" && (await typesOf(o.txRef)) === "fulfilled,initiated,verified");
    // An INSERT is allowed on the append-only table, so an initiated row genuinely dated 30 days ago can be created.
    const oldUser = await makeUser("old");
    const ancientRef = `pslice-${randomUUID()}`;
    await db.$executeRaw(Prisma.sql`INSERT INTO payment_log (user_id, provider, plan_id, billing_interval, tx_ref, event_type, status, amount, currency, created_at)
      VALUES (${oldUser.id}::uuid, 'paystack', 'pro', 'monthly', ${ancientRef}, 'initiated', 'pending', 300000, 'NGN', now() - interval '30 days')`);
    const ancient: Order = { user: oldUser, txRef: ancientRef, interval: "monthly", amount: 300000, providerId: 7_000_000_000 + ++counter };
    check("an initiated reference 30 days old is still honoured when Paystack says it is paid (there is no expiry)", (await fulfil(ancient, { fetchFn: fakePaystack(paystackReply(ancient)).fetchFn })).outcome === "fulfilled" && (await subFor(oldUser.id)) !== null);
  }
  {
    const u = await makeUser("npw"); const o = await makeOrder(u); const p = fakePaystack(paystackReply(o, { status: "abandoned" }));
    const r = await fulfil(o, { source: "webhook", fetchFn: p.fetchFn });
    const ev = await eventsFor(o.txRef);
    const dup = await fulfil(o, { source: "webhook", fetchFn: p.fetchFn });
    check("webhook that Paystack's own verify contradicts: not_paid, recorded as verification_failed, redelivery is a duplicate (no second call)", r.outcome === "not_paid" && ev.length === 1 && ev[0].outcome === "verification_failed" && dup.outcome === "duplicate_event" && p.state.calls === 1);
  }

  console.log("\n== references that are not this caller's ==");
  {
    const a = await makeUser("ua"); const b = await makeUser("ub"); const oa = await makeOrder(a); const p = fakePaystack(paystackReply(oa));
    const otherUser = await fulfil(oa, { fetchFn: p.fetchFn, asUser: b.id });
    check("the page, asking as ANOTHER user: unknown (not_ours), no Paystack call, nothing written", otherUser.outcome === "unknown" && otherUser.reason === "not_ours" && p.state.calls === 0 && (await typesOf(oa.txRef)) === "initiated");
    for (const [name, ref] of [["a well-formed reference nobody owns", `pslice-${randomUUID()}`], ["garbage", "hello"], ["path traversal", "pslice-../../etc/passwd"], ["5000 characters", "x".repeat(5000)], ["empty", ""]] as const) {
      const r = await fulfil(oa, { fetchFn: p.fetchFn, reference: ref });
      check(`${name}: unknown, no Paystack call`, r.outcome === "unknown" && p.state.calls === 0);
    }
    const ghost = webhookEventFor(oa, { txRef: "pslice-not-ours", providerTransactionId: "999", payload: transactionEvidenceSchema.parse({ ...verifyFixture.data, id: 999, reference: `pslice-${randomUUID()}` }) });
    const w1 = await fulfil(oa, { source: "webhook", fetchFn: p.fetchFn, reference: `pslice-${randomUUID()}`, event: ghost });
    const w2 = await fulfil(oa, { source: "webhook", fetchFn: p.fetchFn, reference: `pslice-${randomUUID()}`, event: ghost });
    const ev = await db.webhookEvent.findMany({ where: { providerTransactionId: "999" } });
    check("webhook about a reference we never issued: recorded once as unknown_tx_ref, never fulfilled, no Paystack call; redelivery is a duplicate", w1.outcome === "unknown" && ev.length === 1 && ev[0].outcome === "unknown_tx_ref" && w2.outcome === "duplicate_event" && p.state.calls === 0);
    const nf = await fulfil(oa, { fetchFn: fakePaystack(raw(400, { status: false, code: "transaction_not_found" })).fetchFn });
    check("our reference, but Paystack has no such transaction (code transaction_not_found): unknown (provider_not_found)", nf.outcome === "unknown" && nf.reason === "provider_not_found");
    const nfw = await fulfil(oa, { source: "webhook", fetchFn: fakePaystack(raw(400, { status: false, code: "transaction_not_found" })).fetchFn });
    check("...for a webhook that is NOT recorded (so Paystack's retry can succeed once it is consistent)", nfw.outcome === "unknown" && (await eventsFor(oa.txRef)).length === 0);
  }

  console.log("\n== we cannot find out: nothing written, and a retry then works ==");
  for (const [name, respond, key] of [
    ["network error", () => { throw new TypeError("fetch failed"); }, SECRET], ["timeout", () => { throw new DOMException("timed out", "TimeoutError"); }, SECRET],
    ["HTTP 500", raw(500, "<html>"), SECRET], ["HTTP 429", raw(429, "slow down"), SECRET], ["HTTP 401", raw(401, { status: false }), SECRET],
    ["200 with the wrong shape", raw(200, { status: true, data: {} }), SECRET], ["200 that is not JSON", raw(200, "hello"), SECRET], ["the secret key is not configured", raw(200, {}), undefined],
  ] as [string, () => Response, string | undefined][]) {
    const u = await makeUser("tr"); const o = await makeOrder(u);
    const r = await fulfil(o, { source: "webhook", fetchFn: fakePaystack(respond).fetchFn, secretKey: key });
    check(`${name}: cannot_verify; no ledger rows, no subscription, no webhook row`, r.outcome === "cannot_verify" && (await typesOf(o.txRef)) === "initiated" && !(await subFor(u.id)) && (await eventsFor(o.txRef)).length === 0);
    const retry = await fulfil(o, { source: "webhook", fetchFn: fakePaystack(paystackReply(o)).fetchFn });
    check(`   (${name}) the retry after the outage fulfils normally`, retry.outcome === "fulfilled");
  }

  console.log("\n== atomicity: if any write fails, NOTHING is left behind ==");
  {
    const u = await makeUser("at"); const o = await makeOrder(u);
    const r = await fulfil(o, { fetchFn: fakePaystack(paystackReply(o)).fetchFn, client: tampered(db, { failOn: (sql) => sql.includes("INSERT INTO subscriptions") }) });
    check("the subscription write fails: write_failed", r.outcome === "write_failed");
    check("...and the verified + fulfilled rows written just before it were rolled back too", (await typesOf(o.txRef)) === "initiated" && !(await subFor(u.id)));
    const retry = await fulfil(o, { fetchFn: fakePaystack(paystackReply(o)).fetchFn });
    check("...so the retry fulfils cleanly with exactly the 3 rows", retry.outcome === "fulfilled" && (await typesOf(o.txRef)) === "fulfilled,initiated,verified" && !!(await subFor(u.id)));
  }
  {
    const u = await makeUser("at2"); const o = await makeOrder(u);
    const r = await fulfil(o, { source: "webhook", fetchFn: fakePaystack(paystackReply(o)).fetchFn, client: tampered(db, { failWebhookUpsert: true }) });
    check("the webhook-event write fails: write_failed, and the ledger and subscription are rolled back with it", r.outcome === "write_failed" && (await typesOf(o.txRef)) === "initiated" && !(await subFor(u.id)) && (await eventsFor(o.txRef)).length === 0);
    const retry = await fulfil(o, { source: "webhook", fetchFn: fakePaystack(paystackReply(o)).fetchFn });
    check("...and the redelivery then succeeds (a crash never leaves a half-claimed event)", retry.outcome === "fulfilled" && (await eventsFor(o.txRef)).length === 1);
  }

  console.log("\n== privacy: no card or customer details reach the database ==");
  {
    const u = await makeUser("pv"); const o = await makeOrder(u);
    await fulfil(o, { source: "webhook", fetchFn: fakePaystack(paystackReply(o)).fetchFn });
    const stored = JSON.stringify({ log: await rowsFor(o.txRef), events: await eventsFor(o.txRef), sub: await subFor(u.id) });
    check("Paystack's reply DID contain the sensitive values (so this test is meaningful)", SENSITIVE_VALUES.every((v) => JSON.stringify(verifyFixture).includes(v)));
    check("none of them appears anywhere in the payment_log, webhook_events or subscription rows", SENSITIVE_VALUES.every((v) => !stored.includes(v)));
    check("none of the sensitive key names is stored either", SENSITIVE_KEYS.every((k) => !stored.includes(`"${k}"`)));
  }

  console.log("\n== the real database rules are in force in the isolated schema ==");
  {
    const u = await makeUser("db"); const o = await makeOrder(u);
    await fulfil(o, { fetchFn: fakePaystack(paystackReply(o)).fetchFn });
    const row = (await rowsFor(o.txRef)).find((r) => r.eventType === "fulfilled")!;
    let msg = "";
    try { await db.paymentLog.update({ where: { id: row.id }, data: { status: "failed" } }); } catch (e) { msg = String((e as Error).message); }
    check("the append-only trigger rejects an UPDATE of a fulfilled row", msg.includes("append-only"));
    const u2 = await makeUser("db2"); const a = await makeOrder(u2);
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => appendPaymentLog({ userId: u2.id, provider: "paystack", planId: "pro", billingInterval: "monthly", txRef: a.txRef, providerTransactionId: String(8_000_000_000 + i + counter * 100), eventType: "fulfilled", status: "successful", amount: 300000, currency: "NGN" }, db)));
    check("10 simultaneous raw 'fulfilled' inserts for one reference: exactly 1 succeeds", attempts.filter((x) => x.status === "fulfilled").length === 1 && (await countLog({ txRef: a.txRef, eventType: "fulfilled" })) === 1);
  }

  console.log("\n== logging ==");
  check("the code logged its warnings and errors (captured, not printed)", logged.length > 0, `${logged.length} entries`);
  check("no log entry contains the secret key", !logged.some((l) => l.includes("THIS_MUST_NEVER_LEAK")));
  check("no log entry contains card or customer values", !logged.some((l) => SENSITIVE_VALUES.some((v) => l.includes(v))));
  check("no log entry contains a Paystack response body", !logged.some((l) => l.includes("Verification successful") || l.includes("gateway_response")));

  console.log("\n== the harness cleaned up after itself ==");
  await iso.drop();
  const gone = await admin.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = '${schema}'`);
  check("the temporary schema is dropped", gone[0].n === 0);
  const publicAfter = await iso.realCounts();
  check("your real tables are exactly as they were (payment_log, subscriptions, webhook_events)", JSON.stringify(publicBefore) === JSON.stringify(publicAfter), `${JSON.stringify(publicBefore)} -> ${JSON.stringify(publicAfter)}`);
  await iso.close();

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(inspect(error) + "\n");
  try { await iso?.drop(); await iso?.close(); } catch { /* ignore */ }
  process.exit(1);
});
