// Checks the /checkout/return decision logic against the real local database with a FAKE Paystack.
// Every case runs in a rolled-back transaction with throwaway users (payment_log rows can never be
// deleted, so nothing may be left behind), and EVERY case also proves the logic is read-only: the
// user's payment_log and subscriptions rows are identical before and after.
//
// Run with: npm run check:checkout-return
import { randomUUID } from "crypto";
import { inspect } from "util";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { formatMoney } from "../src/lib/format-money";
import { appendPaymentLog, type PaymentLogEntry } from "../src/lib/payment-log";
import { getReturnStatus, pickReference, type ReturnState } from "../src/lib/checkout/return-status";

class Rollback extends Error {}

// The code under test logs warnings and errors. Capture them (instead of printing hundreds of lines)
// so we can also prove that none of them ever contains the secret key or a Paystack response body.
const logged: string[] = [];
const capture = (...args: unknown[]) => {
  logged.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4 }))).join(" "));
};
console.error = capture;
console.warn = capture;

const url = process.env.DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at a local database.");
  process.exit(1);
}
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

type Tx = Prisma.TransactionClient;
type TestUser = { id: string; email: string };
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

// Ids of every throwaway user this run creates: used to check that OUR rate-limit rows are gone, without
// being confused by real rows (real people's checkout-return attempts share the same key prefix).
const createdUserIds: string[] = [];

// A rolled-back transaction with two throwaway users: A (who views the page) and B (someone else).
async function inTx(fn: (tx: Tx, a: TestUser, b: TestUser) => Promise<void>) {
  try {
    await db.$transaction(async (tx) => {
      const mk = async (label: string): Promise<TestUser> => {
        const u = await tx.user.create({ data: { email: `check-return-${label}-${randomUUID()}@example.com`, name: "Check", passwordHash: "x" } });
        createdUserIds.push(u.id);
        return { id: u.id, email: u.email };
      };
      await fn(tx, await mk("a"), await mk("b"));
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

const SECRET = "sk_test_THIS_MUST_NEVER_LEAK";
const newRef = () => `pslice-${randomUUID()}`;

async function seedOrder(tx: Tx, user: TestUser, opts: { txRef?: string; interval?: "monthly" | "yearly"; amount?: number; extra?: ("failed" | "verified" | "fulfilled")[] } = {}) {
  const txRef = opts.txRef ?? newRef();
  const base = { userId: user.id, provider: "paystack", planId: "pro", billingInterval: opts.interval ?? "monthly", txRef, amount: opts.amount ?? 300000, currency: "NGN" } as const;
  const put = (e: Partial<PaymentLogEntry> & Pick<PaymentLogEntry, "eventType" | "status">) => appendPaymentLog({ ...base, ...e }, tx);
  await put({ eventType: "initiated", status: "pending" });
  for (const extra of opts.extra ?? []) {
    if (extra === "failed") await put({ eventType: "failed", status: "failed" });
    if (extra === "verified") await put({ eventType: "verified", status: "successful", providerTransactionId: "6579832310" });
    if (extra === "fulfilled") await put({ eventType: "fulfilled", status: "successful", providerTransactionId: "6579832310" });
  }
  return txRef;
}

// A fake Paystack /transaction/verify/{reference}.
type Call = { url: string; method?: string; auth?: string };
function fakePaystack(respond: (reference: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (u: string, init: RequestInit) => {
    calls.push({ url: u, method: init?.method, auth: (init?.headers as Record<string, string>)?.Authorization });
    return respond(decodeURIComponent(u.split("/").pop()!));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const reply = (over: { status?: string; reference?: string; amount?: number; currency?: string } = {}) => (ref: string) =>
  new Response(JSON.stringify({ status: true, message: "Verification successful", data: { id: 6579832310, domain: "test", status: over.status ?? "success", reference: over.reference ?? ref, amount: over.amount ?? 300000, currency: over.currency ?? "NGN", gateway_response: "Successful", paid_at: null } }), { status: 200 });
const raw = (status: number, body: unknown) => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const throwing = (e: unknown) => () => { throw e; };

const allow = async () => ({ allowed: true, remaining: 11, retryAfterSeconds: 0 });
const deny = async () => ({ allowed: false, remaining: 0, retryAfterSeconds: 123 });
function recordingConsume(result = allow) {
  const seen: { key: string; limit: { windowSeconds: number; max: number } }[] = [];
  return { fn: (async (key: string, limit: { windowSeconds: number; max: number }) => { seen.push({ key, limit }); return result(); }), seen };
}

// Runs the logic for `user` and asserts it wrote nothing to payment_log or subscriptions.
// `opts.secretKey` may be passed as undefined on purpose: a defaulted parameter would swallow that.
async function run(tx: Tx, user: TestUser, reference: string | undefined, deps: Parameters<typeof getReturnStatus>[1], opts: { secretKey?: string } = {}) {
  const secretKey = "secretKey" in opts ? opts.secretKey : SECRET;
  const snap = async () => `${await tx.paymentLog.count({ where: { userId: user.id } })}/${await tx.subscription.count({ where: { userId: user.id } })}`;
  const before = await snap();
  const state = await getReturnStatus({ userId: user.id, reference, secretKey }, { ...deps, db: tx });
  const after = await snap();
  if (before !== after) check(`READ-ONLY VIOLATED for state ${state.kind}`, false, `payment_log/subscriptions rows ${before} -> ${after}`);
  return { state, readOnly: before === after };
}
const orderIsOurs = (s: ReturnState, amount = 300000) => "order" in s && s.order.amountKobo === amount && s.order.currency === "NGN" && s.order.planName === "Pro" && s.order.billingInterval === "monthly";

async function main() {
  const rowsBefore = await db.paymentLog.count();
  const subsBefore = await db.subscription.count();
  console.log(`(payment_log holds ${rowsBefore} real row(s), subscriptions ${subsBefore}; both must be unchanged at the end)\n`);

  console.log("== every state Paystack can put us in ==");
  const table: [string, Parameters<typeof reply>[0], ReturnState["kind"]][] = [
    ["success, matches our order", {}, "activating"],
    ["failed", { status: "failed" }, "failed"],
    ["abandoned", { status: "abandoned" }, "not_completed"],
    ["reversed", { status: "reversed" }, "reversed"],
    ["unrecognised status 'ongoing'", { status: "ongoing" }, "processing"],
    ["unrecognised status 'pending'", { status: "pending" }, "processing"],
    ["unrecognised status 'queued'", { status: "queued" }, "processing"],
    ["empty status", { status: "" }, "processing"],
    ["success but 1 kobo short", { amount: 299999 }, "mismatch"],
    ["success but the YEARLY amount for a monthly order", { amount: 3000000 }, "mismatch"],
    ["success but a different currency", { currency: "USD" }, "mismatch"],
    ["success but Paystack answered for a different reference", { reference: newRef() }, "mismatch"],
    ["failed with a different amount is still just 'failed'", { status: "failed", amount: 1 }, "failed"],
  ];
  for (const [name, over, expected] of table) {
    await inTx(async (tx, a) => {
      const ref = await seedOrder(tx, a);
      const p = fakePaystack(reply(over));
      const c = recordingConsume();
      const { state } = await run(tx, a, ref, { fetch: p.fetchFn, consume: c.fn });
      check(`${name} -> ${expected}`, state.kind === expected, state.kind);
      check(`   (${name}) shows OUR order (300000 kobo NGN, Pro, monthly), not Paystack's numbers`, orderIsOurs(state));
      check(`   (${name}) exactly one GET /transaction/verify/<ref> with our bearer key`, p.calls.length === 1 && p.calls[0].method === "GET" && p.calls[0].url === `https://api.paystack.co/transaction/verify/${ref}` && p.calls[0].auth === `Bearer ${SECRET}`);
      check(`   (${name}) state never contains the secret key`, !JSON.stringify(state).includes("THIS_MUST_NEVER_LEAK"));
    });
  }

  console.log("\n== we cannot find out: honest 'cannot check', never a guess ==");
  const outages: [string, (ref: string) => Response | Promise<Response>][] = [
    ["HTTP 400 with another error code", raw(400, { status: false, code: "something_else" })],
    ["HTTP 401 (bad key)", raw(401, { status: false, message: "Invalid key" })],
    ["HTTP 429", raw(429, "Too Many Requests")],
    ["HTTP 500", raw(500, "<html>oops</html>")],
    ["network error", throwing(new TypeError("fetch failed"))],
    ["timeout", throwing(new DOMException("timed out", "TimeoutError"))],
    ["200 but not JSON", raw(200, "hello")],
    ["200 with the wrong shape", raw(200, { status: true, data: {} })],
    ["200 with outer status false", raw(200, { status: false, data: {} })],
  ];
  for (const [name, respond] of outages) {
    await inTx(async (tx, a) => {
      const ref = await seedOrder(tx, a);
      const { state } = await run(tx, a, ref, { fetch: fakePaystack(respond).fetchFn, consume: allow });
      check(`${name} -> cannot_check (unavailable), not 'failed'`, state.kind === "cannot_check" && state.reason === "unavailable" && orderIsOurs(state), state.kind);
    });
  }
  await inTx(async (tx, a) => {
    const ref = await seedOrder(tx, a);
    const { state } = await run(tx, a, ref, { fetch: fakePaystack(raw(400, { status: false, message: "Transaction reference not found.", code: "transaction_not_found" })).fetchFn, consume: allow });
    check("Paystack has never heard of our reference (code transaction_not_found) -> unknown", state.kind === "unknown", state.kind);
  });

  console.log("\n== references that are not this person's payment: 'unknown', no Paystack call ==");
  await inTx(async (tx, a, b) => {
    const bRef = await seedOrder(tx, b);
    const bDone = await seedOrder(tx, b, { extra: ["verified", "fulfilled"] });
    const p = fakePaystack(reply());
    const c = recordingConsume();
    const bad: [string, string | undefined][] = [
      ["missing", undefined], ["empty", ""], ["garbage", "hello"], ["wrong prefix", `xslice-${randomUUID()}`], ["uppercase", newRef().toUpperCase()],
      ["path traversal", "pslice-../../etc/passwd"], ["5000 characters", "x".repeat(5000)], ["well-formed but nobody's", newRef()],
      ["another user's pending reference", bRef], ["another user's FULFILLED reference", bDone],
    ];
    for (const [name, ref] of bad) {
      const { state } = await run(tx, a, ref, { fetch: p.fetchFn, consume: c.fn });
      check(`${name} -> unknown`, state.kind === "unknown", state.kind);
    }
    check("...and none of them caused a Paystack call or used up any rate limit", p.calls.length === 0 && c.seen.length === 0, `calls=${p.calls.length} limiter calls=${c.seen.length}`);
    const own = await run(tx, b, bDone, { fetch: p.fetchFn, consume: c.fn });
    check("(control) the owner of that same fulfilled reference DOES see it as successful", own.state.kind === "successful");
  });

  console.log("\n== already fulfilled: our ledger is enough ==");
  await inTx(async (tx, a) => {
    const ref = await seedOrder(tx, a, { extra: ["verified", "fulfilled"] });
    const p = fakePaystack(reply({ status: "failed" })); // even if Paystack would now say otherwise, we do not ask
    const c = recordingConsume();
    const { state } = await run(tx, a, ref, { fetch: p.fetchFn, consume: c.fn });
    check("fulfilled row -> successful, with our order", state.kind === "successful" && orderIsOurs(state));
    check("...with NO Paystack call and NO rate-limit use", p.calls.length === 0 && c.seen.length === 0);
  });
  await inTx(async (tx, a) => {
    const ref = await seedOrder(tx, a, { extra: ["failed"] });
    const { state } = await run(tx, a, ref, { fetch: fakePaystack(raw(400, { code: "transaction_not_found" })).fetchFn, consume: allow });
    check("our initiation failed and Paystack never heard of it -> unknown", state.kind === "unknown", state.kind);
  });
  await inTx(async (tx, a) => {
    const ref = await seedOrder(tx, a, { extra: ["failed"] });
    const { state } = await run(tx, a, ref, { fetch: fakePaystack(reply({ status: "abandoned" })).fetchFn, consume: allow });
    check("our initiation timed out but Paystack HAD created it (ambiguous timeout) -> not_completed", state.kind === "not_completed", state.kind);
  });

  console.log("\n== rate limiting (fake limiter) ==");
  await inTx(async (tx, a) => {
    const ref = await seedOrder(tx, a);
    const p = fakePaystack(reply());
    const c = recordingConsume(deny);
    const { state } = await run(tx, a, ref, { fetch: p.fetchFn, consume: c.fn });
    check("limit reached -> cannot_check (rate_limited) with the wait time", state.kind === "cannot_check" && state.reason === "rate_limited" && state.retryAfterSeconds === 123 && orderIsOurs(state), JSON.stringify({ k: state.kind }));
    check("...and NO Paystack call was made", p.calls.length === 0);
    check("limiter keyed per user, 12 per 600 s", c.seen[0]?.key === `checkout-return:user:${a.id}` && c.seen[0].limit.max === 12 && c.seen[0].limit.windowSeconds === 600, JSON.stringify(c.seen[0]));
  });
  await inTx(async (tx, a) => {
    const ref = await seedOrder(tx, a);
    const p = fakePaystack(reply());
    const { state } = await run(tx, a, ref, { fetch: p.fetchFn, consume: async () => { throw new Error("db down"); } });
    check("limiter itself errors -> cannot_check (unavailable), no Paystack call", state.kind === "cannot_check" && state.reason === "unavailable" && p.calls.length === 0);
  });
  for (const key of [undefined, ""]) {
    await inTx(async (tx, a) => {
      const ref = await seedOrder(tx, a);
      const p = fakePaystack(reply());
      const c = recordingConsume();
      const { state } = await run(tx, a, ref, { fetch: p.fetchFn, consume: c.fn }, { secretKey: key });
      check(`PAYSTACK_SECRET_KEY ${key === undefined ? "missing" : "empty"} -> cannot_check, nothing called`, state.kind === "cannot_check" && p.calls.length === 0 && c.seen.length === 0);
    });
  }

  console.log("\n== rate limiting (the REAL limiter, 12 per 10 minutes) ==");
  {
    const attemptsKeyPrefix = "checkout-return:user:";
    let userIdUsed = "";
    await inTx(async (tx, a) => {
      userIdUsed = a.id;
      const ref = await seedOrder(tx, a);
      const p = fakePaystack(reply());
      const states: string[] = [];
      for (let i = 0; i < 14; i++) states.push((await run(tx, a, ref, { fetch: p.fetchFn })).state.kind); // real consume
      check("14 unresolved views: first 12 reach Paystack, the 13th and 14th are refused", p.calls.length === 12 && states.slice(0, 12).every((s) => s === "activating") && states.slice(12).every((s) => s === "cannot_check"), `paystack calls=${p.calls.length}; ${states.slice(10).join(", ")}`);
      const fulfilled = await seedOrder(tx, a, { extra: ["verified", "fulfilled"] });
      const before = (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM rate_limit_attempts WHERE key = ${attemptsKeyPrefix + a.id}`)[0].n;
      for (let i = 0; i < 30; i++) await run(tx, a, fulfilled, { fetch: p.fetchFn });
      const after = (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM rate_limit_attempts WHERE key = ${attemptsKeyPrefix + a.id}`)[0].n;
      check("30 views of a FULFILLED payment use none of the limit (still 12 attempts stored) and make no Paystack call", before === 12 && after === 12 && p.calls.length === 12, `stored ${before} -> ${after}`);
    });
    await db.$executeRaw`DELETE FROM rate_limit_attempts WHERE key = ${attemptsKeyPrefix + userIdUsed}`;
  }

  console.log("\n== which query parameter is used ==");
  const R1 = newRef();
  const R2 = newRef();
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
  check("the code did log its warnings and errors (captured, not printed)", logged.length > 0, `${logged.length} log entries`);
  check("no log entry contains the secret key", !logged.some((l) => l.includes("THIS_MUST_NEVER_LEAK")));
  check("no log entry contains a Paystack response body", !logged.some((l) => l.includes("Verification successful") || l.includes("gateway_response")));

  console.log("\n== nothing left behind ==");
  check("payment_log real row count unchanged", (await db.paymentLog.count()) === rowsBefore, `${rowsBefore} -> ${await db.paymentLog.count()}`);
  check("subscriptions real row count unchanged", (await db.subscription.count()) === subsBefore);
  check("no throwaway users left", (await db.user.count({ where: { email: { startsWith: "check-return-" } } })) === 0);
  const ourKeys = createdUserIds.map((id) => `checkout-return:user:${id}`);
  const leftover = (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM rate_limit_attempts WHERE key IN (${Prisma.join(ourKeys)})`)[0].n;
  check("no rate-limit rows left for this script's own throwaway users", leftover === 0, `${ourKeys.length} throwaway users checked, ${leftover} rows left`);

  await db.$disconnect();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(inspect(error) + "\n");
  await db.$executeRaw`DELETE FROM rate_limit_attempts WHERE key LIKE 'checkout-return:user:%'`.catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
