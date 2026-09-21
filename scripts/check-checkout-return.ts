// Checks what the /checkout/return page does, against a temporary copy of the database structure (real
// migrations, real trigger and indexes: scripts/lib/isolated-schema.ts) with a FAKE Paystack.
//
// The page decides nothing itself: it hands the reference to fulfilTransaction() and reports the result. So
// these checks assert exactly what gets written for each situation, and that repeating a visit writes
// nothing more. Your real payment tables are never touched (their row counts are compared at the end).
//
// Run with: npm run check:checkout-return
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { inspect } from "util";
import { Prisma, type PrismaClient } from "../src/generated/prisma/client";
import { fulfilTransaction } from "../src/lib/checkout/fulfil";
import { getReturnStatus, pickReference, type ReturnState } from "../src/lib/checkout/return-status";
import { formatMoney } from "../src/lib/format-money";
import { appendPaymentLog } from "../src/lib/payment-log";
import { createIsolatedSchema, type Isolated } from "./lib/isolated-schema";

// Everything the code logs is captured (not printed), so we can prove it never contains the key or card details.
const logged: string[] = [];
const capture = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4 }))).join(" ")); };
console.error = capture;
console.warn = capture;

let iso: Isolated | undefined;
let db!: PrismaClient;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

const SECRET = "sk_test_THIS_MUST_NEVER_LEAK";
const verifyFixture = JSON.parse(readFileSync(join(process.cwd(), "scripts", "fixtures", "paystack", "verify-success.json"), "utf8"));
const SENSITIVE_VALUES = ["AUTH_FAKE_0000", "SIG_FAKE_0000", "customer@example.com", "CUS_fake0000", "203.0.113.10"];

// ---------- helpers ----------
type User = { id: string; email: string };
type Order = { user: User; txRef: string; amount: number; providerId: number };
let counter = 0;
const createdUserIds: string[] = [];

async function makeUser(label: string): Promise<User> {
  const u = await db.user.create({ data: { email: `return-${label}-${randomUUID()}@example.com`, name: "Return Test", passwordHash: "x" } });
  createdUserIds.push(u.id);
  return { id: u.id, email: u.email };
}
async function makeOrder(user: User, opts: { interval?: "monthly" | "yearly" } = {}): Promise<Order> {
  const interval = opts.interval ?? "monthly";
  const amount = interval === "monthly" ? 300000 : 3000000;
  const txRef = `pslice-${randomUUID()}`;
  await appendPaymentLog({ userId: user.id, provider: "paystack", planId: "pro", billingInterval: interval, txRef, eventType: "initiated", status: "pending", amount, currency: "NGN" }, db);
  return { user, txRef, amount, providerId: 5_000_000_000 + ++counter };
}

// A fake Paystack /transaction/verify/{reference}: a full, realistic reply (card and customer objects included).
const reply = (o: Order, over: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({ ...verifyFixture, data: { ...verifyFixture.data, id: o.providerId, reference: o.txRef, amount: o.amount, currency: "NGN", status: "success", ...over } }), { status: 200 });
const raw = (status: number, body: unknown) => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const throwing = (e: unknown) => () => { throw e; };
type Call = { url: string; method?: string; auth?: string };
function fakePaystack(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (u: string, init: RequestInit) => { calls.push({ url: u, method: init?.method, auth: (init?.headers as Record<string, string>)?.Authorization }); return respond(); }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const allow = async () => ({ allowed: true, remaining: 11, retryAfterSeconds: 0 });
const deny = async () => ({ allowed: false, remaining: 0, retryAfterSeconds: 123 });
function recordingConsume(result = allow) {
  const seen: { key: string; limit: { windowSeconds: number; max: number } }[] = [];
  return { seen, fn: async (key: string, limit: { windowSeconds: number; max: number }) => { seen.push({ key, limit }); return result(); } };
}

async function counts(user: User) {
  return { log: await db.paymentLog.count({ where: { userId: user.id } }), subs: await db.subscription.count({ where: { userId: user.id } }) };
}
const ledger = async (txRef: string) => (await db.paymentLog.findMany({ where: { txRef } })).map((r) => r.eventType).sort().join(",");

async function visit(user: User, reference: string | undefined, deps: Parameters<typeof getReturnStatus>[1] = {}, opts: { secretKey?: string } = {}) {
  const secretKey = "secretKey" in opts ? opts.secretKey : SECRET;
  return getReturnStatus({ userId: user.id, reference, secretKey }, { db, ...deps });
}
const orderIsOurs = (s: ReturnState, amount = 300000) => "order" in s && s.order.amountKobo === amount && s.order.currency === "NGN" && s.order.planName === "Pro" && s.order.billingInterval === (amount === 300000 ? "monthly" : "yearly");

async function main() {
  iso = await createIsolatedSchema("check_return");
  db = iso.db;
  const realBefore = await iso.realCounts();
  console.log("(temporary copy of the database structure created; your real payment tables are not touched)\n");

  console.log("== every situation: what the page shows AND exactly what gets written ==");
  const table: [string, Record<string, unknown>, ReturnState["kind"], { log: number; subs: number }][] = [
    ["Paystack: paid, matches our order", {}, "successful", { log: 2, subs: 1 }],
    ["Paystack: failed", { status: "failed" }, "failed", { log: 0, subs: 0 }],
    ["Paystack: abandoned", { status: "abandoned" }, "not_completed", { log: 0, subs: 0 }],
    ["Paystack: reversed", { status: "reversed" }, "reversed", { log: 0, subs: 0 }],
    ["Paystack: unrecognised status 'ongoing'", { status: "ongoing" }, "processing", { log: 0, subs: 0 }],
    ["Paystack: unrecognised status 'pending'", { status: "pending" }, "processing", { log: 0, subs: 0 }],
    ["Paystack: unrecognised status 'queued'", { status: "queued" }, "processing", { log: 0, subs: 0 }],
    ["Paystack: empty status", { status: "" }, "processing", { log: 0, subs: 0 }],
    ["Paystack: 'SUCCESS' in capitals is NOT success", { status: "SUCCESS" }, "processing", { log: 0, subs: 0 }],
    ["Paystack: paid but 1 kobo short", { amount: 299999 }, "mismatch", { log: 1, subs: 0 }],
    ["Paystack: paid the YEARLY amount for a monthly order", { amount: 3000000 }, "mismatch", { log: 1, subs: 0 }],
    ["Paystack: paid in a different currency", { currency: "USD" }, "mismatch", { log: 1, subs: 0 }],
    ["Paystack: answers about a different reference", { reference: `pslice-${randomUUID()}` }, "mismatch", { log: 1, subs: 0 }],
    ["Paystack: failed, with a different amount, is still just 'failed'", { status: "failed", amount: 1 }, "failed", { log: 0, subs: 0 }],
  ];
  for (const [name, over, expected, writes] of table) {
    const u = await makeUser("s"); const o = await makeOrder(u); const p = fakePaystack(reply(o, over)); const c = recordingConsume();
    const before = await counts(u);
    const state = await visit(u, o.txRef, { fetch: p.fetchFn, consume: c.fn });
    const after = await counts(u);
    check(`${name} -> ${expected}`, state.kind === expected, state.kind);
    check(`   writes exactly ${writes.log} ledger row(s) and ${writes.subs} subscription`, after.log - before.log === writes.log && after.subs - before.subs === writes.subs, `${after.log - before.log} rows, ${after.subs - before.subs} subscriptions`);
    check(`   shows OUR order (300000 kobo NGN, Pro, monthly), not Paystack's numbers`, orderIsOurs(state));
    check(`   asked Paystack once: GET /transaction/verify/<ref> with our bearer key`, p.calls.length === 1 && p.calls[0].method === "GET" && p.calls[0].url === `https://api.paystack.co/transaction/verify/${o.txRef}` && p.calls[0].auth === `Bearer ${SECRET}`);
    check(`   the state never contains the secret key or card details`, !JSON.stringify(state).includes("THIS_MUST_NEVER_LEAK") && SENSITIVE_VALUES.every((v) => !JSON.stringify(state).includes(v)));
    if (expected === "successful") {
      const again = await visit(u, o.txRef, { fetch: p.fetchFn, consume: c.fn });
      const afterAgain = await counts(u);
      check(`   a second visit: still successful, writes NOTHING more, no second Paystack call, no limit used`, again.kind === "successful" && afterAgain.log === after.log && afterAgain.subs === after.subs && p.calls.length === 1 && c.seen.length === 1);
      check(`   the ledger holds initiated + verified + fulfilled and the subscription is active`, (await ledger(o.txRef)) === "fulfilled,initiated,verified" && (await db.subscription.findUnique({ where: { userId: u.id } }))?.status === "active");
    }
    if (expected === "mismatch") {
      await visit(u, o.txRef, { fetch: p.fetchFn, consume: c.fn }); await visit(u, o.txRef, { fetch: p.fetchFn, consume: c.fn });
      check(`   three visits still leave exactly ONE 'failed' row and no subscription`, (await db.paymentLog.count({ where: { txRef: o.txRef, eventType: "failed" } })) === 1 && (await counts(u)).subs === 0);
    }
  }

  console.log("\n== we cannot find out: an honest 'cannot check', never a guess; nothing written; a retry works ==");
  const outages: [string, () => Response | Promise<Response>][] = [
    ["HTTP 400 with another error code", raw(400, { status: false, code: "something_else" })], ["HTTP 401 (bad key)", raw(401, { status: false })], ["HTTP 429", raw(429, "Too Many Requests")],
    ["HTTP 500", raw(500, "<html>oops</html>")], ["network error", throwing(new TypeError("fetch failed"))], ["timeout", throwing(new DOMException("timed out", "TimeoutError"))],
    ["200 but not JSON", raw(200, "hello")], ["200 with the wrong shape", raw(200, { status: true, data: {} })], ["200 with outer status false", raw(200, { status: false, data: {} })],
  ];
  for (const [name, respond] of outages) {
    const u = await makeUser("o"); const o = await makeOrder(u); const before = await counts(u);
    const state = await visit(u, o.txRef, { fetch: fakePaystack(respond).fetchFn, consume: allow });
    check(`${name} -> cannot_check (unavailable), not 'failed'; nothing written`, state.kind === "cannot_check" && state.reason === "unavailable" && orderIsOurs(state) && same(await counts(u), before));
    const retry = await visit(u, o.txRef, { fetch: fakePaystack(reply(o)).fetchFn, consume: allow });
    check(`   (${name}) the visit after the outage fulfils normally`, retry.kind === "successful" && (await ledger(o.txRef)) === "fulfilled,initiated,verified");
  }
  {
    const u = await makeUser("nf"); const o = await makeOrder(u);
    const state = await visit(u, o.txRef, { fetch: fakePaystack(raw(400, { status: false, message: "Transaction reference not found.", code: "transaction_not_found" })).fetchFn, consume: allow });
    check("Paystack has never heard of our reference (code transaction_not_found) -> unknown, nothing written", state.kind === "unknown" && (await ledger(o.txRef)) === "initiated");
  }

  console.log("\n== our own write fails after Paystack confirmed: 'activating', nothing half-done, checking again fixes it ==");
  {
    const u = await makeUser("wf"); const o = await makeOrder(u);
    const bind = <T extends object>(t: T, p: string | symbol) => { const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v; };
    const dead = new Proxy(db, { get: (t, p) => (p === "$transaction" ? () => Promise.reject(new Error("simulated database failure")) : bind(t, p)) });
    const state = await visit(u, o.txRef, { db: dead, fetch: fakePaystack(reply(o)).fetchFn, consume: allow });
    check("write fails -> 'activating' (Paystack says paid), with our order", state.kind === "activating" && orderIsOurs(state));
    check("...and NOTHING was left behind (no verified row, no fulfilled row, no subscription)", (await ledger(o.txRef)) === "initiated" && (await counts(u)).subs === 0);
    const again = await visit(u, o.txRef, { fetch: fakePaystack(reply(o)).fetchFn, consume: allow });
    check("...so the next visit (the page re-checks by itself) completes it", again.kind === "successful" && (await ledger(o.txRef)) === "fulfilled,initiated,verified");
  }

  console.log("\n== references that are not this person's payment: 'unknown', no Paystack call, and nothing triggered ==");
  {
    const a = await makeUser("a"); const b = await makeUser("b");
    const aPending = await makeOrder(a); const p = fakePaystack(reply(aPending)); const c = recordingConsume();
    const aDone = await makeOrder(a); await fulfilTransaction({ reference: aDone.txRef, source: "return_page", expectedUserId: a.id, secretKey: SECRET }, { db, fetch: fakePaystack(reply(aDone)).fetchFn });
    const bad: [string, string | undefined][] = [
      ["missing", undefined], ["empty", ""], ["garbage", "hello"], ["wrong prefix", `xslice-${randomUUID()}`], ["uppercase", `pslice-${randomUUID()}`.toUpperCase()],
      ["path traversal", "pslice-../../etc/passwd"], ["5000 characters", "x".repeat(5000)], ["well-formed but nobody's", `pslice-${randomUUID()}`],
      ["another user's PENDING reference", aPending.txRef], ["another user's FULFILLED reference", aDone.txRef],
    ];
    for (const [name, ref] of bad) {
      const state = await visit(b, ref, { fetch: p.fetchFn, consume: c.fn });
      check(`as another user: ${name} -> unknown`, state.kind === "unknown", state.kind);
    }
    check("...none of them caused a Paystack call or used any rate limit", p.calls.length === 0 && c.seen.length === 0);
    check("...and the other user's unpaid order was NOT fulfilled by someone else visiting it", (await ledger(aPending.txRef)) === "initiated" && (await counts(b)).log === 0);
    const owner = await visit(a, aDone.txRef, { fetch: p.fetchFn, consume: c.fn });
    check("(control) the owner of that fulfilled reference sees it as successful", owner.kind === "successful");
  }

  console.log("\n== already fulfilled (say, by the webhook first): our ledger is enough ==");
  {
    const u = await makeUser("wh"); const o = await makeOrder(u);
    const hook = await fulfilTransaction({ reference: o.txRef, source: "webhook", secretKey: SECRET, webhookEvent: { eventType: "charge.success", providerTransactionId: String(o.providerId), providerStatus: "success", txRef: o.txRef, payload: { id: o.providerId, status: "success", reference: o.txRef, amount: 300000, currency: "NGN" } } }, { db, fetch: fakePaystack(reply(o)).fetchFn });
    const p = fakePaystack(reply(o, { status: "failed" })); const c = recordingConsume(); const before = await counts(u);
    const state = await visit(u, o.txRef, { fetch: p.fetchFn, consume: c.fn });
    check("the webhook fulfilled it first; the page then shows successful", hook.outcome === "fulfilled" && state.kind === "successful" && orderIsOurs(state));
    check("...with NO Paystack call, NO rate-limit use and NOTHING written (even if Paystack would now say otherwise)", p.calls.length === 0 && c.seen.length === 0 && same(await counts(u), before));
  }
  {
    const u = await makeUser("pg"); const o = await makeOrder(u); const p = fakePaystack(reply(o));
    const state = await visit(u, o.txRef, { fetch: p.fetchFn, consume: allow });
    const hook = await fulfilTransaction({ reference: o.txRef, source: "webhook", secretKey: SECRET, webhookEvent: { eventType: "charge.success", providerTransactionId: String(o.providerId), providerStatus: "success", txRef: o.txRef, payload: { id: o.providerId, status: "success", reference: o.txRef, amount: 300000, currency: "NGN" } } }, { db, fetch: p.fetchFn });
    check("the page fulfilled it FIRST; the webhook that follows finds it done", state.kind === "successful" && hook.outcome === "already_fulfilled" && (await ledger(o.txRef)) === "fulfilled,initiated,verified");
  }
  {
    let bad = 0; let worst = "";
    for (let trial = 0; trial < 10; trial++) {
      const u = await makeUser("cc"); const o = await makeOrder(u); const p = fakePaystack(reply(o));
      const states = await Promise.all(Array.from({ length: 20 }, () => visit(u, o.txRef, { fetch: p.fetchFn, consume: allow })));
      const okTrial = states.every((s) => s.kind === "successful") && (await db.paymentLog.count({ where: { txRef: o.txRef, eventType: "fulfilled" } })) === 1 && (await db.paymentLog.count({ where: { txRef: o.txRef, eventType: "verified" } })) === 1 && (await counts(u)).subs === 1 && (await db.$queryRaw<{ ok: boolean }[]>`SELECT (current_period_end = current_period_start + interval '1 month') AS ok FROM subscriptions WHERE user_id = ${u.id}::uuid`)[0].ok;
      if (!okTrial) { bad++; worst = [...new Set(states.map((s) => s.kind))].join("/"); }
    }
    check("10 trials x 20 simultaneous visits of one paid reference: everyone sees 'successful', exactly one fulfilment, one month of subscription", bad === 0, worst);
  }

  console.log("\n== rate limiting (fake limiter) ==");
  {
    const u = await makeUser("rl"); const o = await makeOrder(u); const p = fakePaystack(reply(o)); const c = recordingConsume(deny); const before = await counts(u);
    const state = await visit(u, o.txRef, { fetch: p.fetchFn, consume: c.fn });
    check("limit reached -> cannot_check (rate_limited) with the wait time and our order", state.kind === "cannot_check" && state.reason === "rate_limited" && state.retryAfterSeconds === 123 && orderIsOurs(state));
    check("...NO Paystack call, NOTHING written", p.calls.length === 0 && same(await counts(u), before));
    check("limiter keyed per user, 12 per 600 s", c.seen[0]?.key === `checkout-return:user:${u.id}` && c.seen[0].limit.max === 12 && c.seen[0].limit.windowSeconds === 600, JSON.stringify(c.seen[0]));
  }
  {
    const u = await makeUser("rle"); const o = await makeOrder(u); const p = fakePaystack(reply(o));
    const state = await visit(u, o.txRef, { fetch: p.fetchFn, consume: async () => { throw new Error("db down"); } });
    check("the limiter itself errors -> cannot_check (unavailable), no Paystack call, nothing written", state.kind === "cannot_check" && state.reason === "unavailable" && p.calls.length === 0 && (await ledger(o.txRef)) === "initiated");
  }
  for (const key of [undefined, ""]) {
    const u = await makeUser("nk"); const o = await makeOrder(u); const p = fakePaystack(reply(o)); const c = recordingConsume();
    const state = await visit(u, o.txRef, { fetch: p.fetchFn, consume: c.fn }, { secretKey: key });
    check(`PAYSTACK_SECRET_KEY ${key === undefined ? "missing" : "empty"} -> cannot_check, nothing called, nothing written`, state.kind === "cannot_check" && p.calls.length === 0 && c.seen.length === 0 && (await ledger(o.txRef)) === "initiated");
  }

  console.log("\n== rate limiting (the REAL limiter: 12 Paystack checks per 10 minutes) ==");
  {
    const u = await makeUser("real"); const o = await makeOrder(u); const p = fakePaystack(reply(o, { status: "ongoing" }));
    const kinds: string[] = [];
    for (let i = 0; i < 14; i++) kinds.push((await visit(u, o.txRef, { fetch: p.fetchFn })).kind);
    check("14 unresolved visits: the first 12 reach Paystack, the 13th and 14th are refused", p.calls.length === 12 && kinds.slice(0, 12).every((k) => k === "processing") && kinds.slice(12).every((k) => k === "cannot_check"), `${p.calls.length} Paystack calls; last kinds: ${kinds.slice(10).join(", ")}`);
    const paid = await makeOrder(u); const p2 = fakePaystack(reply(paid));
    await visit(u, paid.txRef, { fetch: p2.fetchFn, consume: allow });
    const used = async () => (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM public.rate_limit_attempts WHERE key = ${"checkout-return:user:" + u.id}`)[0].n;
    const before = await used();
    for (let i = 0; i < 30; i++) await visit(u, paid.txRef, { fetch: p2.fetchFn });
    check("30 more views of a FULFILLED payment use none of the limit and make no Paystack call", before === (await used()) && p2.calls.length === 1, `limit rows ${before} -> ${await used()}`);
  }

  console.log("\n== which query parameter is used ==");
  const R1 = `pslice-${randomUUID()}`; const R2 = `pslice-${randomUUID()}`;
  check("reference is used", pickReference({ reference: R1 }) === R1);
  check("trxref is the fallback", pickReference({ trxref: R2 }) === R2);
  check("both present: reference wins", pickReference({ reference: R1, trxref: R2 }) === R1);
  check("neither -> undefined", pickReference({}) === undefined);
  check("repeated reference (array) -> undefined, not the first value", pickReference({ reference: [R1, R2] }) === undefined);
  check("repeated trxref only -> undefined", pickReference({ trxref: [R1, R2] }) === undefined);

  console.log("\n== money is shown from integer kobo ==");
  check("300000 NGN -> ₦3,000.00", formatMoney(300000, "NGN") === "₦3,000.00", formatMoney(300000, "NGN"));
  check("3000000 NGN -> ₦30,000.00", formatMoney(3000000, "NGN") === "₦30,000.00", formatMoney(3000000, "NGN"));

  console.log("\n== logging ==");
  check("the code logged its warnings and errors (captured, not printed)", logged.length > 0, `${logged.length} entries`);
  check("no log entry contains the secret key", !logged.some((l) => l.includes("THIS_MUST_NEVER_LEAK")));
  check("no log entry contains card or customer values or a Paystack response body", !logged.some((l) => SENSITIVE_VALUES.some((v) => l.includes(v)) || l.includes("Verification successful") || l.includes("gateway_response")));

  console.log("\n== nothing left behind ==");
  // The real limiter wrote rate-limit rows (they are deletable) to the real table: remove exactly the keys this run made.
  const ourKeys = createdUserIds.map((id) => `checkout-return:user:${id}`);
  await iso.admin.$executeRaw`DELETE FROM public.rate_limit_attempts WHERE key IN (${Prisma.join(ourKeys)})`;
  const leftover = (await iso.admin.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM public.rate_limit_attempts WHERE key IN (${Prisma.join(ourKeys)})`)[0].n;
  check("no rate-limit rows left for this script's own throwaway users", leftover === 0, `${ourKeys.length} users checked, ${leftover} rows left`);
  await iso.drop();
  const realAfter = await iso.realCounts();
  check("your real tables are exactly as they were (payment_log, subscriptions, webhook_events)", same(realBefore, realAfter), `${JSON.stringify(realBefore)} -> ${JSON.stringify(realAfter)}`);
  await iso.close();

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }

main().catch(async (error) => {
  process.stderr.write(inspect(error) + "\n");
  try { await iso?.drop(); await iso?.close(); } catch { /* ignore */ }
  process.exit(1);
});
