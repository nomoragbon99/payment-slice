// Checks the checkout-initiation logic against the real local database with a FAKE Paystack (no
// network). Every case runs inside a transaction that is rolled back, because payment_log rows can
// never be deleted (append-only trigger), so nothing this script does is left behind.
//
// Each case creates its OWN throwaway user inside that transaction, so the results do not depend on
// what else is in the database (real test payments, seeded users, earlier runs). No seed is needed.
//
// Run with: npm run check:checkout
import { randomUUID } from "crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { initiateCheckout, type InitiateCheckoutInput } from "../src/lib/checkout/initiate";

class Rollback extends Error {}

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

// Runs fn inside a transaction, with a fresh throwaway user, and always rolls everything back.
async function inTx(fn: (tx: Tx, user: TestUser) => Promise<void>) {
  try {
    await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: `check-checkout-${randomUUID()}@example.com`, name: "Check User", passwordHash: "not-a-real-hash" },
      });
      await fn(tx, { id: user.id, email: user.email });
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

const SECRET = "sk_test_THIS_MUST_NEVER_BE_STORED";
const APP_URL = "http://localhost:3002";

// A fake Paystack: answers with the given status/body and remembers how it was called.
function fakePaystack(respond: (reference: string) => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    return respond(body.reference);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const okResponse = (reference: string) =>
  new Response(
    JSON.stringify({ status: true, message: "Authorization URL created", data: { authorization_url: "https://checkout.paystack.com/abc123", access_code: "abc123", reference } }),
    { status: 200 },
  );
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const input = (user: TestUser, over: Partial<InitiateCheckoutInput> = {}): InitiateCheckoutInput => ({
  userId: user.id, email: user.email, billingInterval: "monthly", appUrl: APP_URL, secretKey: SECRET, ...over,
});

async function main() {
  const rowsBefore = await db.paymentLog.count();
  console.log(`(payment_log already holds ${rowsBefore} real row(s); they must be untouched and must not affect any case below)\n`);

  console.log("== happy path ==");
  await inTx(async (tx, user) => {
    const p = fakePaystack(okResponse);
    const r = await initiateCheckout(input(user), { fetch: p.fetchFn, db: tx });
    check("returns ok with the Paystack URL", r.ok && r.authorizationUrl === "https://checkout.paystack.com/abc123");
    const rows = await tx.paymentLog.findMany({ where: { userId: user.id } });
    check("exactly one payment_log row", rows.length === 1, `rows=${rows.length}`);
    const row = rows[0];
    check("row is initiated/pending/paystack/pro/monthly", row.eventType === "initiated" && row.status === "pending" && row.provider === "paystack" && row.planId === "pro" && row.billingInterval === "monthly");
    check("amount 300000 kobo and NGN, from plan config", row.amount === 300000 && row.currency === "NGN", `${row.amount} ${row.currency}`);
    check("no provider transaction id yet", row.providerTransactionId === null);
    check("tx_ref starts with pslice- and is what Paystack was sent", row.txRef.startsWith("pslice-") && p.calls[0].body.reference === row.txRef, row.txRef);
    check("Paystack was called once, at /transaction/initialize", p.calls.length === 1 && p.calls[0].url === "https://api.paystack.co/transaction/initialize");
    check("Paystack got amount 300000 (integer kobo), email and callback_url", p.calls[0].body.amount === 300000 && p.calls[0].body.email === user.email && p.calls[0].body.callback_url === "http://localhost:3002/checkout/return", JSON.stringify(p.calls[0].body));
    const raw = row.rawResponse as Record<string, unknown>;
    check("raw_response holds our outgoing request", raw.reference === row.txRef && raw.amount === 300000 && raw.callback_url === "http://localhost:3002/checkout/return");
    check("secret key is not in the stored row", !JSON.stringify(row).includes("THIS_MUST_NEVER_BE_STORED"));
  });

  console.log("\n== yearly price ==");
  await inTx(async (tx, user) => {
    const p = fakePaystack(okResponse);
    await initiateCheckout(input(user, { billingInterval: "yearly" }), { fetch: p.fetchFn, db: tx });
    const row = (await tx.paymentLog.findMany({ where: { userId: user.id } }))[0];
    check("yearly = 3000000 kobo, interval yearly", row.amount === 3000000 && row.billingInterval === "yearly" && p.calls[0].body.amount === 3000000);
  });

  console.log("\n== two attempts get two different references ==");
  await inTx(async (tx, user) => {
    const p = fakePaystack(okResponse);
    const a = await initiateCheckout(input(user), { fetch: p.fetchFn, db: tx });
    const b = await initiateCheckout(input(user), { fetch: p.fetchFn, db: tx });
    check("tx_refs differ", a.ok && b.ok && a.txRef !== b.txRef);
  });

  console.log("\n== Paystack failures: one initiated row, then an appended failed row ==");
  const failureCases: [string, (ref: string) => Response | Promise<Response>, string][] = [
    ["network error", () => { throw new TypeError("fetch failed"); }, "network_error"],
    ["timeout", () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, "network_error"],
    ["400 invalid amount", () => jsonResponse(400, { status: false, message: "Invalid amount" }), "http_error"],
    ["401 invalid key", () => jsonResponse(401, { status: false, message: "Invalid key" }), "http_error"],
    ["429 rate limited by Paystack", () => new Response("Too Many Requests", { status: 429 }), "http_error"],
    ["500 server error", () => new Response("<html>oops</html>", { status: 500 }), "http_error"],
    ["200 but not JSON", () => new Response("not json", { status: 200 }), "bad_response"],
    ["200 with wrong shape", () => jsonResponse(200, { status: true, data: {} }), "bad_response"],
    ["200 with someone else's reference", () => jsonResponse(200, { status: true, data: { authorization_url: "https://checkout.paystack.com/x", reference: "not-ours" } }), "bad_response"],
    ["200 with a non-Paystack URL", (ref) => jsonResponse(200, { status: true, data: { authorization_url: "https://evil.example/pay", reference: ref } }), "bad_response"],
  ];
  for (const [name, respond, kind] of failureCases) {
    await inTx(async (tx, user) => {
      const p = fakePaystack(respond);
      const r = await initiateCheckout(input(user), { fetch: p.fetchFn, db: tx });
      const rows = await tx.paymentLog.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
      const [first, second] = rows;
      check(
        `${name}: PROVIDER_FAILED, rows = [initiated, failed]`,
        !r.ok && r.code === "PROVIDER_FAILED" && rows.length === 2 && first.eventType === "initiated" && second?.eventType === "failed",
        rows.map((x) => x.eventType).join(","),
      );
      check(
        `${name}: failed row is status failed, same tx_ref, amount and currency, evidence kind=${kind}`,
        second?.status === "failed" && second.txRef === first.txRef && second.amount === first.amount && second.currency === first.currency && (second.rawResponse as Record<string, unknown>)?.kind === kind,
      );
      check(`${name}: initiated row left untouched (still pending)`, first.status === "pending");
      check(`${name}: secret key not stored anywhere`, !JSON.stringify(rows).includes("THIS_MUST_NEVER_BE_STORED"));
    });
  }

  console.log("\n== already subscribed ==");
  const later = () => new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const earlier = () => new Date(Date.now() - 24 * 3600 * 1000);
  const sub = (userId: string, status: string, end: Date) => ({ userId, planId: "pro", billingInterval: "monthly", status, currentPeriodStart: new Date(Date.now() - 60 * 24 * 3600 * 1000), currentPeriodEnd: end, lastTxRef: "pslice-old" });
  await inTx(async (tx, user) => {
    await tx.subscription.create({ data: sub(user.id, "active", later()) });
    const p = fakePaystack(okResponse);
    const r = await initiateCheckout(input(user), { fetch: p.fetchFn, db: tx });
    check("active + period not over -> ALREADY_SUBSCRIBED", !r.ok && r.code === "ALREADY_SUBSCRIBED");
    check("...no log row written and Paystack never called", (await tx.paymentLog.count({ where: { userId: user.id } })) === 0 && p.calls.length === 0);
  });
  await inTx(async (tx, user) => {
    await tx.subscription.create({ data: sub(user.id, "active", earlier()) });
    const r = await initiateCheckout(input(user), { fetch: fakePaystack(okResponse).fetchFn, db: tx });
    check("active but period already ended -> allowed", r.ok);
  });
  await inTx(async (tx, user) => {
    await tx.subscription.create({ data: sub(user.id, "canceled", later()) });
    const r = await initiateCheckout(input(user), { fetch: fakePaystack(okResponse).fetchFn, db: tx });
    check("canceled -> allowed", r.ok);
  });
  await inTx(async (tx, user) => {
    await tx.subscription.create({ data: sub(user.id, "past_due", later()) });
    const r = await initiateCheckout(input(user), { fetch: fakePaystack(okResponse).fetchFn, db: tx });
    check("past_due -> allowed (they need to pay)", r.ok);
  });

  console.log("\n== not configured: fail before writing anything ==");
  for (const [name, over] of [["PAYSTACK_SECRET_KEY missing", { secretKey: undefined }], ["PAYSTACK_SECRET_KEY empty", { secretKey: "" }], ["APP_URL missing", { appUrl: undefined }]] as const) {
    await inTx(async (tx, user) => {
      const p = fakePaystack(okResponse);
      const r = await initiateCheckout(input(user, over), { fetch: p.fetchFn, db: tx });
      check(`${name} -> NOT_CONFIGURED, no rows, no Paystack call`, !r.ok && r.code === "NOT_CONFIGURED" && (await tx.paymentLog.count({ where: { userId: user.id } })) === 0 && p.calls.length === 0);
    });
  }

  console.log("\n== log-write failures ==");
  await inTx(async (tx, user) => {
    let n = 0;
    const flaky = { subscription: tx.subscription, paymentLog: { create: ((args: never) => { n++; if (n === 2) throw new Error("db went away"); return tx.paymentLog.create(args); }) as unknown as Tx["paymentLog"]["create"] } } as unknown as Pick<Tx, "subscription" | "paymentLog">;
    const r = await initiateCheckout(input(user), { fetch: fakePaystack(() => jsonResponse(500, {})).fetchFn, db: flaky });
    check("failed-row write fails -> still PROVIDER_FAILED (no throw), initiated row remains", !r.ok && r.code === "PROVIDER_FAILED" && (await tx.paymentLog.count({ where: { userId: user.id } })) === 1);
  });
  await inTx(async (tx, user) => {
    const p = fakePaystack(okResponse);
    const broken = { subscription: tx.subscription, paymentLog: { create: (() => { throw new Error("db is down"); }) as unknown as Tx["paymentLog"]["create"] } } as unknown as Pick<Tx, "subscription" | "paymentLog">;
    let threw = false;
    try { await initiateCheckout(input(user), { fetch: p.fetchFn, db: broken }); } catch { threw = true; }
    check("initiated-row write fails -> error propagates and Paystack is NOT called", threw && p.calls.length === 0);
  });

  console.log("\n== append-only still holds for rows this code writes ==");
  await inTx(async (tx, user) => {
    await initiateCheckout(input(user), { fetch: fakePaystack(okResponse).fetchFn, db: tx });
    const row = (await tx.paymentLog.findMany({ where: { userId: user.id } }))[0];
    let msg = "";
    try { await tx.paymentLog.update({ where: { id: row.id }, data: { status: "successful" } }); } catch (e) { msg = String((e as Error).message); }
    check("UPDATE of the initiated row is rejected by the trigger", msg.includes("append-only"), msg.split("\n").filter(Boolean).pop()?.slice(0, 100));
  });

  console.log("\n== nothing left behind ==");
  const rowsAfter = await db.paymentLog.count();
  check("payment_log row count is the same after every case (all rolled back)", rowsAfter === rowsBefore, `before=${rowsBefore} after=${rowsAfter}`);
  const strayUsers = await db.user.count({ where: { email: { startsWith: "check-checkout-" } } });
  check("no throwaway users left behind", strayUsers === 0, `left=${strayUsers}`);

  await db.$disconnect();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
