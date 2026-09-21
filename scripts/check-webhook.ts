// Proves the Paystack webhook end to end through the real handler: signature check on the raw bytes, size limits,
// parsing, idempotency, and the hand-off to fulfilTransaction, using genuinely SIGNED requests, a fake Paystack
// and a temporary copy of the database structure (scripts/lib/isolated-schema.ts: real migrations, real
// trigger and indexes, dropped afterwards; your real tables are never touched).
//
// If the real captures from the live test exist locally (tmp/real-webhooks/, gitignored) and PAYSTACK_SECRET_KEY
// is set, Paystack's own genuine signed bytes are replayed through the handler too.
//
// Run with: npm run check:webhook
import { createHmac, randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { inspect } from "util";
import type { PrismaClient } from "../src/generated/prisma/client";
import * as route from "../src/app/api/webhooks/paystack/route";
import { appendPaymentLog } from "../src/lib/payment-log";
import { isValidWebhookSignature, MAX_WEBHOOK_BYTES, parseWebhookBody } from "../src/lib/paystack/webhook";
import { handlePaystackWebhook } from "../src/lib/paystack/webhook-handler";
import { createIsolatedSchema, type Isolated } from "./lib/isolated-schema";

// Everything the code logs is captured, so we can prove it never contains the key, a signature or card details.
const logged: string[] = [];
const capture = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4 }))).join(" ")); };
console.error = capture;
console.warn = capture;
console.info = capture;

let iso: Isolated | undefined;
let db!: PrismaClient;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

const SECRET = "sk_test_webhook_check_secret_key";
const fixtureDir = join(process.cwd(), "scripts", "fixtures", "paystack");
const webhookFixture = JSON.parse(readFileSync(join(fixtureDir, "charge-success.json"), "utf8"));
const verifyFixture = JSON.parse(readFileSync(join(fixtureDir, "verify-success.json"), "utf8"));
const SENSITIVE_VALUES = ["AUTH_FAKE_0000", "SIG_FAKE_0000", "customer@example.com", "CUS_fake0000", "203.0.113.10"];
const SENSITIVE_KEYS = ["authorization", "authorization_code", "customer", "email", "last4", "signature", "ip_address", "metadata", "fees"];
const EVIDENCE_KEYS = ["amount", "channel", "currency", "domain", "gateway_response", "id", "paid_at", "reference", "status"];
const sign = (bytes: Buffer | string, key = SECRET) => createHmac("sha512", key).update(bytes).digest("hex");

// ---------- helpers ----------
let counter = 0;
type Order = { userId: string; txRef: string; amount: number; providerId: number };
async function makeOrder(): Promise<Order> {
  const u = await db.user.create({ data: { email: `webhook-${randomUUID()}@example.com`, name: "Webhook Test", passwordHash: "x" } });
  const txRef = `pslice-${randomUUID()}`;
  await appendPaymentLog({ userId: u.id, provider: "paystack", planId: "pro", billingInterval: "monthly", txRef, eventType: "initiated", status: "pending", amount: 300000, currency: "NGN" }, db);
  return { userId: u.id, txRef, amount: 300000, providerId: 6_000_000_000 + ++counter };
}
// A charge.success body exactly as Paystack formats it (compact JSON), with the FULL card/customer objects in it.
const chargeBody = (o: Pick<Order, "txRef" | "providerId" | "amount">, over: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ ...webhookFixture, data: { ...webhookFixture.data, id: o.providerId, reference: o.txRef, amount: o.amount, currency: "NGN", status: "success", ...over } }), "utf8");
const verifyReply = (o: Order, over: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({ ...verifyFixture, data: { ...verifyFixture.data, id: o.providerId, reference: o.txRef, amount: o.amount, currency: "NGN", status: "success", ...over } }), { status: 200 });
const raw = (status: number, body: unknown) => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
function fakePaystack(respond: () => Response | Promise<Response>) {
  const state = { calls: 0 };
  return { state, fetchFn: (async () => { state.calls++; return respond(); }) as unknown as typeof fetch };
}

type PostOpts = { signature?: string | null; secretKey?: string | undefined; fetchFn?: typeof fetch; client?: PrismaClient; headers?: Record<string, string>; noContentLength?: boolean };
async function post(body: Buffer | string, opts: PostOpts = {}) {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Paystack/2.0", ...opts.headers };
  const signature = "signature" in opts ? opts.signature : sign(bytes);
  if (signature !== null && signature !== undefined) headers["x-paystack-signature"] = signature;
  const request = new Request("http://localhost:3002/api/webhooks/paystack", { method: "POST", headers, body: new Uint8Array(bytes) });
  const response = await handlePaystackWebhook(request, { secretKey: "secretKey" in opts ? opts.secretKey : SECRET, db: opts.client ?? db, fetch: opts.fetchFn });
  return { status: response.status, text: await response.text(), retryAfter: response.headers.get("retry-after"), contentType: response.headers.get("content-type") };
}
const events = (txRef: string) => db.webhookEvent.findMany({ where: { txRef } });
const ledger = async (txRef: string) => (await db.paymentLog.findMany({ where: { txRef } })).map((r) => r.eventType).sort().join(",");
const totals = async () => ({ log: await db.paymentLog.count(), events: await db.webhookEvent.count(), subs: await db.subscription.count() });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  iso = await createIsolatedSchema("check_webhook");
  db = iso.db;
  const realBefore = await iso.realCounts();

  console.log("== signature algorithm: independent known answers (computed with openssl, not Node) ==");
  const V1 = { key: "key", body: Buffer.from('{"event":"charge.success"}'), hex: "4a07914a3da81a8fcb9633fceb0dc23217ee7f207d773b6f24ba589e197261284626599e27e50dfad0b5a54cd4e80e3e0e3d4426dbab97216bf14b771627e461" };
  const V2 = { key: "sk_test_known_answer_key", body: Buffer.from('{"n":"Zoë — ₦3,000"}\n', "utf8"), hex: "d2ba0b807f375746ba4f5458103de96cc9ead46481e965ac6bf2746d8394cb41124dda461b6215b2771df87bb5efdd430102d0966a243adc919bd0012518795b" };
  const V3 = { key: "k", body: Buffer.alloc(0), hex: "893ccbf5d0b335fcda6f625e4a59055a364d75a9251589428750782c116830a1af455efe1094c1901d0e8fd5beb6df64c6d5fe1c6f09be6ef47fb3987260cdd8" };
  const SHA256_OF_V1 = "ab61a787c5999437517c5cd665ddce82f801ff1dfb542d3321713f2be60e862a";
  for (const [name, v] of [["ASCII body", V1], ["UTF-8 body with a trailing newline", V2], ["empty body", V3]] as const) {
    check(`openssl's HMAC-SHA512 for ${name} is accepted`, isValidWebhookSignature(v.body, v.hex, v.key));
    check(`   ...and the SAME signature is refused under another key, or for another body`, !isValidWebhookSignature(v.body, v.hex, v.key + "x") && !isValidWebhookSignature(Buffer.concat([v.body, Buffer.from(" ")]), v.hex, v.key));
  }
  check("an HMAC-SHA256 of the same body is refused (the algorithm is SHA-512)", !isValidWebhookSignature(V1.body, SHA256_OF_V1, V1.key));

  console.log("\n== signature edge cases ==");
  const good = V1.hex;
  const cases: [string, string | null | undefined][] = [
    ["missing header", null], ["undefined header", undefined], ["empty header", ""], ["uppercase hex", good.toUpperCase()], ["truncated (127 chars)", good.slice(0, 127)],
    ["one extra character", good + "0"], ["leading space", " " + good], ["trailing space", good + " "], ["trailing newline", good + "\n"], ["the first 64 characters only", good.slice(0, 64)],
    ["all zeros", "0".repeat(128)], ["last character changed", good.slice(0, 127) + (good.endsWith("1") ? "2" : "1")], ["non-hex text of the right length", "z".repeat(128)],
  ];
  for (const [name, header] of cases) check(`${name}: refused`, !isValidWebhookSignature(V1.body, header, V1.key));
  check("an empty secret key never validates anything", !isValidWebhookSignature(V1.body, good, ""));

  console.log("\n== the route module ==");
  const exported = Object.keys(route).sort();
  check("only POST is exported (every other method gets a 405 from Next)", same(exported, ["POST", "dynamic"]), exported.join(","));
  check("the route is never cached (force-dynamic)", route.dynamic === "force-dynamic");

  console.log("\n== authentication comes first: nothing else happens without a valid signature ==");
  {
    const o = await makeOrder(); const p = fakePaystack(verifyReply(o)); const before = await totals();
    const body = chargeBody(o);
    const attempts: [string, PostOpts][] = [
      ["no signature header", { signature: null, fetchFn: p.fetchFn }], ["empty signature", { signature: "", fetchFn: p.fetchFn }],
      ["signature of a DIFFERENT body", { signature: sign("something else"), fetchFn: p.fetchFn }], ["signature made with the WRONG key", { signature: sign(body, "wrong-key"), fetchFn: p.fetchFn }],
      ["uppercase signature", { signature: sign(body).toUpperCase(), fetchFn: p.fetchFn }], ["an HMAC-SHA256 instead of SHA-512", { signature: createHmac("sha256", SECRET).update(body).digest("hex"), fetchFn: p.fetchFn }],
    ];
    for (const [name, opts] of attempts) {
      const r = await post(body, opts);
      check(`${name}: 401, and the body says nothing about why`, r.status === 401 && r.text === '{"received":false}');
    }
    for (const pos of [0, 10, 100, body.length - 1]) {
      const tampered = Buffer.from(body); tampered[pos] ^= 0x01;
      const r = await post(tampered, { signature: sign(body), fetchFn: p.fetchFn });
      check(`one bit flipped at byte ${pos} after signing: 401`, r.status === 401);
    }
    const r1 = await post(Buffer.concat([body, Buffer.from("\n")]), { signature: sign(body), fetchFn: p.fetchFn });
    check("a newline appended after signing: 401 (the raw bytes are what is signed)", r1.status === 401);
    const notJson = Buffer.from("this is not json at all");
    const r2 = await post(notJson, { signature: "bad", fetchFn: p.fetchFn });
    check("an UNSIGNED body that is not even JSON: 401, not 400 (authenticated before it is ever parsed)", r2.status === 401);
    check("all of that caused NO Paystack call and wrote NOTHING to the database", p.state.calls === 0 && same(await totals(), before));
    const r3 = await post(body, { secretKey: undefined, fetchFn: p.fetchFn });
    check("our own secret key not configured: 500, nothing written, no Paystack call", r3.status === 500 && p.state.calls === 0 && same(await totals(), before));
  }

  console.log("\n== size limits ==");
  {
    const before = await totals(); const junk = (n: number) => Buffer.alloc(n, 0x61);
    let r = await post(junk(MAX_WEBHOOK_BYTES + 1));
    check(`a body of ${MAX_WEBHOOK_BYTES + 1} bytes: 413 (before any signature work)`, r.status === 413);
    r = await post(junk(1024 * 1024));
    check("a 1 MB body: 413, and it was never read in full", r.status === 413);
    const big = Buffer.from(JSON.stringify({ event: "transfer.success", pad: "x".repeat(MAX_WEBHOOK_BYTES - 60) }));
    r = await post(big.subarray(0, MAX_WEBHOOK_BYTES));
    check("a body of exactly the limit is not rejected for size", r.status !== 413, `status ${r.status}`);
    const lying = await handlePaystackWebhook(new Request("http://localhost:3002/api/webhooks/paystack", { method: "POST", headers: { "content-length": String(MAX_WEBHOOK_BYTES + 5000), "x-paystack-signature": "x" }, body: "tiny" }), { secretKey: SECRET, db });
    check("a Content-Length header over the limit: 413 without reading the body", lying.status === 413);
    check("no size-limit case wrote anything", same(await totals(), before));
  }

  console.log("\n== signed, but not a body we can act on: 400 ==");
  {
    const p = fakePaystack(verifyReply(await makeOrder())); const before = await totals();
    const dataOf =(over: Record<string, unknown>) => ({ event: "charge.success", data: { ...webhookFixture.data, ...over } });
    const bad: [string, Buffer | string][] = [
      ["not JSON", "hello"], ["a JSON array", "[1,2,3]"], ["JSON null", "null"], ["an empty object", "{}"], ["event is a number", JSON.stringify({ event: 5, data: {} })],
      ["event is empty", JSON.stringify({ event: "", data: {} })], ["event name of 101 characters", JSON.stringify({ event: "e".repeat(101), data: {} })],
      ["charge.success without data", JSON.stringify({ event: "charge.success" })], ["data is a string", JSON.stringify({ event: "charge.success", data: "x" })],
      ["data.id is a string", JSON.stringify(dataOf({ id: "123" }))], ["data.amount is a decimal", JSON.stringify(dataOf({ amount: 3000.5 }))], ["data.amount is a string", JSON.stringify(dataOf({ amount: "300000" }))],
      ["data.reference is missing", JSON.stringify(dataOf({ reference: undefined }))], ["data.currency is missing", JSON.stringify(dataOf({ currency: undefined }))], ["data.status is missing", JSON.stringify(dataOf({ status: undefined }))],
      ["invalid UTF-8 bytes", Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ];
    for (const [name, body] of bad) {
      const r = await post(body, { fetchFn: p.fetchFn });
      check(`${name}: 400, body says nothing about why`, r.status === 400 && r.text === '{"received":false}');
    }
    check("...with no Paystack call and nothing written", p.state.calls === 0 && same(await totals(), before));
  }

  console.log("\n== event types we do not handle: acknowledged, never stored ==");
  {
    const p = fakePaystack(verifyReply(await makeOrder())); const before = await totals();
    for (const event of["transfer.success", "transfer.failed", "refund.processed", "charge.dispute.create", "invoice.create", "subscription.create", "customeridentification.success", "charge.failed", "Charge.Success", "charge.success "]) {
      const r = await post(JSON.stringify({ event, data: { id: 1, reference: "x" } }), { fetchFn: p.fetchFn });
      check(`${JSON.stringify(event)}: 200 and ignored`, r.status === 200 && r.text === '{"received":true}');
    }
    check("...with no Paystack call and nothing stored", p.state.calls === 0 && same(await totals(), before));
  }

  console.log("\n== a real successful payment, signed ==");
  {
    const o = await makeOrder(); const p = fakePaystack(verifyReply(o)); const body = chargeBody(o);
    const r = await post(body, { fetchFn: p.fetchFn, headers: { origin: "https://evil.example", cookie: "session=irrelevant" } });
    check("200 with a tiny fixed body, JSON content type", r.status === 200 && r.text === '{"received":true}' && (r.contentType ?? "").includes("application/json"));
    check("no session and no origin check applies to a server-to-server webhook (a foreign Origin header changes nothing)", r.status === 200);
    check("Paystack was asked to verify (the webhook body alone grants nothing)", p.state.calls === 1);
    check("ledger: initiated + verified + fulfilled; one active subscription", (await ledger(o.txRef)) === "fulfilled,initiated,verified" && (await db.subscription.count({ where: { userId: o.userId } })) === 1);
    const ev = await events(o.txRef);
    check("webhook_events: one row (paystack, charge.success, the transaction id, success), outcome fulfilled", ev.length === 1 && ev[0].provider === "paystack" && ev[0].eventType === "charge.success" && ev[0].providerTransactionId === String(o.providerId) && ev[0].providerStatus === "success" && ev[0].outcome === "fulfilled" && ev[0].processedAt !== null);
    check("its payload is the trimmed evidence (9 keys)", same(Object.keys(ev[0].payload as object).sort(), EVIDENCE_KEYS));
    const stored = JSON.stringify({ log: await db.paymentLog.findMany({ where: { txRef: o.txRef } }), events: ev });
    check("the signed body contained the card and customer objects, and NONE of it reached the database", SENSITIVE_VALUES.every((v) => body.toString().includes(v)) && SENSITIVE_VALUES.every((v) => !stored.includes(v)) && SENSITIVE_KEYS.every((k) => !stored.includes(`"${k}"`)));
  }

  console.log("\n== the signature covers the RAW bytes: formatting does not matter, altering it does ==");
  {
    const o = await makeOrder(); const p = fakePaystack(verifyReply(o));
    const pretty = Buffer.from(JSON.stringify({ ...webhookFixture, data: { ...webhookFixture.data, id: o.providerId, reference: o.txRef, amount: o.amount } }, null, 4).replace(/\n/g, "\r\n"), "utf8");
    const r = await post(pretty, { fetchFn: p.fetchFn });
    check("a pretty-printed, CRLF body signed as-is is accepted (a parse-and-reserialise check would have refused it)", r.status === 200 && (await ledger(o.txRef)) === "fulfilled,initiated,verified");
    const o2 = await makeOrder();
    const escaped = Buffer.from(chargeBody(o2).toString("utf8").replace("NGN", "\\u004eGN"), "utf8");
    const r2 = await post(escaped, { fetchFn: fakePaystack(verifyReply(o2)).fetchFn });
    check("a body with unicode escapes signed as-is is accepted", r2.status === 200 && (await ledger(o2.txRef)) === "fulfilled,initiated,verified");
  }

  console.log("\n== redelivery: idempotent, and the same event never acts twice ==");
  {
    const o = await makeOrder(); const p = fakePaystack(verifyReply(o)); const body = chargeBody(o);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(body, { fetchFn: p.fetchFn })).status);
    check("the same signed delivery 5 times: all 200", codes.every((c) => c === 200));
    check("exactly one event row, one fulfilment, one verified row, ONE Paystack call in total", (await events(o.txRef)).length === 1 && (await ledger(o.txRef)) === "fulfilled,initiated,verified" && p.state.calls === 1);
    check("the subscription is exactly one month (the redeliveries did not extend it)", (await db.$queryRaw<{ ok: boolean }[]>`SELECT (current_period_end = current_period_start + interval '1 month') AS ok FROM subscriptions WHERE user_id = ${o.userId}::uuid`)[0].ok);
  }
  {
    let bad = 0; let worst = "";
    for (let trial = 0; trial < 10; trial++) {
      const o = await makeOrder(); const p = fakePaystack(verifyReply(o)); const body = chargeBody(o);
      const rs = await Promise.all(Array.from({ length: 20 }, () => post(body, { fetchFn: p.fetchFn })));
      const ok = rs.every((r) => r.status === 200) && (await events(o.txRef)).length === 1 && (await ledger(o.txRef)) === "fulfilled,initiated,verified";
      if (!ok) { bad++; worst = [...new Set(rs.map((r) => r.status))].join("/"); }
    }
    check("10 trials x 20 IDENTICAL deliveries at the same instant: all 200, exactly one event row and one fulfilment each time", bad === 0, worst);
  }

  console.log("\n== received_at is the true ARRIVAL time, stamped before anything else ==");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  {
    // A slow Paystack: the verify call takes 400 ms. Arrival and completion must now be visibly apart.
    const o = await makeOrder();
    const p = fakePaystack(async () => { await sleep(400); return verifyReply(o)(); });
    const sentAt = Date.now();
    const r = await post(chargeBody(o), { fetchFn: p.fetchFn });
    const [ev] = await events(o.txRef);
    const gap = ev.processedAt!.getTime() - ev.receivedAt.getTime();
    check("slow verify (Paystack takes 400 ms): 200, and arrival is never later than processing", r.status === 200 && ev.receivedAt.getTime() <= ev.processedAt!.getTime());
    check("...the gap between arrival and completion is visible: about the 400 ms the verify call took (380 ms to 3 s)", gap >= 380 && gap < 3000, `${gap} ms`);
    check("...and received_at is when the request ARRIVED (within 150 ms of sending it), not when the row was written", ev.receivedAt.getTime() >= sentAt - 5 && ev.receivedAt.getTime() - sentAt < 150, `${ev.receivedAt.getTime() - sentAt} ms after sending`);
  }
  {
    // The arrival time is taken BEFORE the body is read: here the body itself takes 350 ms to arrive.
    const o = await makeOrder(); const bytes = chargeBody(o);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(bytes.subarray(0, 100)));
        await sleep(350);
        controller.enqueue(new Uint8Array(bytes.subarray(100)));
        controller.close();
      },
    });
    const request = new Request("http://localhost:3002/api/webhooks/paystack", { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": sign(bytes) }, body: stream, duplex: "half" } as RequestInit);
    const sentAt = Date.now();
    const res = await handlePaystackWebhook(request, { secretKey: SECRET, db, fetch: fakePaystack(verifyReply(o)).fetchFn });
    const [ev] = await events(o.txRef);
    check("a body that takes 350 ms to arrive is still accepted (200)", res.status === 200 && (await ledger(o.txRef)) === "fulfilled,initiated,verified");
    check("received_at is the moment the request STARTED (stamped before the body was read), not after the 350 ms wait", ev.receivedAt.getTime() - sentAt < 100, `${ev.receivedAt.getTime() - sentAt} ms after sending`);
    check("...so processed_at is at least 340 ms later (the body wait is now part of the visible gap)", ev.processedAt!.getTime() - ev.receivedAt.getTime() >= 340, `${ev.processedAt!.getTime() - ev.receivedAt.getTime()} ms`);
  }
  {
    // A redelivery must not rewrite the FIRST arrival time.
    const o = await makeOrder(); const p = fakePaystack(verifyReply(o)); const body = chargeBody(o);
    await post(body, { fetchFn: p.fetchFn });
    const [first] = await events(o.txRef);
    await sleep(150);
    const second = await post(body, { fetchFn: p.fetchFn });
    const [after] = await events(o.txRef);
    check("a redelivery 150 ms later: 200, and the row still holds the FIRST arrival time", second.status === 200 && after.receivedAt.getTime() === first.receivedAt.getTime() && (await events(o.txRef)).length === 1);
  }
  {
    // An outcome with no Paystack call at all still stamps the arrival time.
    const ghost = { txRef: `pslice-${randomUUID()}`, providerId: 6_910_000_001, amount: 300000 };
    const sentAt = Date.now();
    await post(chargeBody(ghost), { fetchFn: fakePaystack(verifyReply(await makeOrder())).fetchFn });
    const [g] = await events(ghost.txRef);
    check("a reference we never issued (unknown_tx_ref, no Paystack call): received_at is still the arrival time", g?.outcome === "unknown_tx_ref" && g.receivedAt.getTime() >= sentAt - 5 && g.receivedAt.getTime() <= g.processedAt!.getTime());
  }

  console.log("\n== references we never issued ==");
  {
    const p = fakePaystack(verifyReply(await makeOrder()));
    const ghost = { txRef: `pslice-${randomUUID()}`, providerId: 6_900_000_001, amount: 300000 };
    const body = chargeBody(ghost);
    const codes = [(await post(body, { fetchFn: p.fetchFn })).status, (await post(body, { fetchFn: p.fetchFn })).status, (await post(body, { fetchFn: p.fetchFn })).status];
    const ev = await events(ghost.txRef);
    check("a well-formed reference nobody owns: 200 every time, recorded ONCE as unknown_tx_ref, never fulfilled, no Paystack call", codes.every((c) => c === 200) && ev.length === 1 && ev[0].outcome === "unknown_tx_ref" && p.state.calls === 0 && (await ledger(ghost.txRef)) === "");
    const junk = chargeBody({ txRef: "hello", providerId: 6_900_000_002, amount: 1 });
    const r = await post(junk, { fetchFn: p.fetchFn });
    check("a garbage reference ('hello') in a validly signed body: 200, recorded as unknown_tx_ref", r.status === 200 && (await events("hello"))[0]?.outcome === "unknown_tx_ref");
    const long = chargeBody({ txRef: "z".repeat(5000), providerId: 6_900_000_003, amount: 1 });
    const r2 = await post(long, { fetchFn: p.fetchFn });
    const stored = await db.webhookEvent.findFirst({ where: { providerTransactionId: "6900000003" } });
    check("a 5000-character reference: 200, and the column holds at most 200 characters of it", r2.status === 200 && stored?.txRef.length === 200);
  }

  console.log("\n== paid, but not what we recorded; or Paystack says it is not paid ==");
  {
    const o = await makeOrder(); const p = fakePaystack(verifyReply(o, { amount: 299999 })); const body = chargeBody(o);
    const r = await post(body, { fetchFn: p.fetchFn });
    const again = await post(body, { fetchFn: p.fetchFn });
    const ev = await events(o.txRef);
    check("the webhook says paid, but Paystack's verify reports 1 kobo less: 200, recorded as amount_mismatch once, NO subscription, one 'failed' row", r.status === 200 && again.status === 200 && ev.length === 1 && ev[0].outcome === "amount_mismatch" && (await db.subscription.count({ where: { userId: o.userId } })) === 0 && (await ledger(o.txRef)) === "failed,initiated");
    const o2 = await makeOrder(); const p2 = fakePaystack(verifyReply(o2, { status: "abandoned" }));
    const r2 = await post(chargeBody(o2), { fetchFn: p2.fetchFn });
    const ev2 = await events(o2.txRef);
    check("the webhook says paid, but Paystack's own verify says abandoned: 200, recorded as verification_failed, nothing activated", r2.status === 200 && ev2[0]?.outcome === "verification_failed" && (await ledger(o2.txRef)) === "initiated" && (await db.subscription.count({ where: { userId: o2.userId } })) === 0);
  }

  console.log("\n== we cannot finish: 503 so Paystack retries, nothing half-done, and the retry works ==");
  for (const [name, respond] of [["Paystack answers HTTP 500", raw(500, "<html>")], ["Paystack answers HTTP 429", raw(429, "slow down")], ["Paystack answers HTTP 401", raw(401, { status: false })], ["a network error", () => { throw new TypeError("fetch failed"); }], ["a timeout", () => { throw new DOMException("timed out", "TimeoutError"); }], ["Paystack answers with nonsense", raw(200, { status: true, data: {} })], ["Paystack has no such transaction yet (transaction_not_found)", raw(400, { status: false, code: "transaction_not_found" })]] as [string, () => Response][]) {
    const o = await makeOrder(); const body = chargeBody(o);
    const r = await post(body, { fetchFn: fakePaystack(respond).fetchFn });
    check(`${name}: 503 with Retry-After, and no event, no ledger rows, no subscription`, r.status === 503 && r.retryAfter !== null && r.text === '{"received":false}' && (await events(o.txRef)).length === 0 && (await ledger(o.txRef)) === "initiated" && (await db.subscription.count({ where: { userId: o.userId } })) === 0);
    const retry = await post(body, { fetchFn: fakePaystack(verifyReply(o)).fetchFn });
    check(`   (${name}) Paystack's retry of the same delivery then fulfils normally`, retry.status === 200 && (await ledger(o.txRef)) === "fulfilled,initiated,verified" && (await events(o.txRef)).length === 1);
  }
  {
    const o = await makeOrder(); const body = chargeBody(o);
    const bind = <T extends object>(t: T, p: string | symbol) => { const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v; };
    const dead = new Proxy(db, { get: (t, p) => (p === "$transaction" ? () => Promise.reject(new Error("simulated database failure")) : bind(t, p)) });
    const r = await post(body, { client: dead, fetchFn: fakePaystack(verifyReply(o)).fetchFn });
    check("our database write fails after Paystack confirmed: 503, nothing left behind", r.status === 503 && (await ledger(o.txRef)) === "initiated" && (await events(o.txRef)).length === 0);
    const retry = await post(body, { fetchFn: fakePaystack(verifyReply(o)).fetchFn });
    check("...and the retry then succeeds", retry.status === 200 && (await ledger(o.txRef)) === "fulfilled,initiated,verified");
    const exploding = new Proxy(db, { get: (t, p) => (p === "webhookEvent" ? { findUnique: () => Promise.reject(new Error("boom")) } : bind(t, p)) });
    const o2 = await makeOrder();
    const r2 = await post(chargeBody(o2), { client: exploding, fetchFn: fakePaystack(verifyReply(o2)).fetchFn });
    check("an unexpected exception anywhere: 503 (retry later), never a crash or a 200", r2.status === 503);
  }

  console.log("\n== Paystack's own genuine signed deliveries (the real captures from the live test) ==");
  const realDir = join(process.cwd(), "tmp", "real-webhooks");
  const realKey = process.env.PAYSTACK_SECRET_KEY;
  if (existsSync(realDir) && realKey) {
    const files = readdirSync(realDir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      const meta = JSON.parse(readFileSync(join(realDir, f), "utf8"));
      const bytes = readFileSync(join(realDir, f.replace(".json", ".body")));
      const header = meta.headers["x-paystack-signature"] as string;
      const label = f.slice(0, 19);
      check(`${label}: our HMAC-SHA512 check ACCEPTS Paystack's real signature`, isValidWebhookSignature(bytes, header, realKey));
      const flipped = Buffer.from(bytes); flipped[20] ^= 0x01;
      check(`${label}: ...and refuses the real body with one bit changed`, !isValidWebhookSignature(flipped, header, realKey));
      const parsed = parseWebhookBody(bytes);
      check(`${label}: it parses as charge.success with the 9 evidence keys only`, parsed.kind === "charge_success" && same(Object.keys(parsed.evidence).sort(), EVIDENCE_KEYS) && !JSON.stringify(parsed.evidence).includes("@"));
      const p = fakePaystack(raw(500, ""));
      const r1 = await handlePaystackWebhook(new Request("http://localhost:3002/api/webhooks/paystack", { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": header }, body: new Uint8Array(bytes) }), { secretKey: realKey, db, fetch: p.fetchFn });
      const r2 = await handlePaystackWebhook(new Request("http://localhost:3002/api/webhooks/paystack", { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": header }, body: new Uint8Array(bytes) }), { secretKey: realKey, db, fetch: p.fetchFn });
      const rows = await db.webhookEvent.findMany({ where: { providerTransactionId: String((parsed as { evidence: { id: number } }).evidence.id) } });
      check(`${label}: through the handler: 200 (its reference is not in the temporary database, so it is recorded as unknown_tx_ref); replayed: still 1 row`, r1.status === 200 && r2.status === 200 && rows.length === 1 && rows[0].outcome === "unknown_tx_ref" && p.state.calls === 0);
      check(`${label}: the stored payload holds no e-mail address and no card details`, !JSON.stringify(rows[0].payload).includes("@") && SENSITIVE_KEYS.every((k) => !JSON.stringify(rows[0].payload).includes(`"${k}"`)));
    }
    if (files.length === 0) console.log("(no real captures found: skipped)");
  } else {
    console.log("(skipped: the real captures in tmp/real-webhooks/ are not present, or PAYSTACK_SECRET_KEY is not loaded)");
  }

  console.log("\n== the invariant over every event recorded in this whole run ==");
  {
    const rowsTotal = await db.webhookEvent.count();
    const backwards = (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM webhook_events WHERE received_at > processed_at`)[0].n;
    check("no webhook_events row anywhere has received_at LATER than processed_at (the impossible order the old column had)", rowsTotal > 20 && backwards === 0, `${rowsTotal} rows checked, ${backwards} backwards`);
  }

  console.log("\n== logging ==");
  const signatures = [V1.hex, V2.hex, V3.hex, SHA256_OF_V1];
  check("the handler logged its warnings and errors (captured, not printed)", logged.length > 0, `${logged.length} entries`);
  check("no log entry contains the secret key", !logged.some((l) => l.includes(SECRET) || (realKey ? l.includes(realKey) : false)));
  check("no log entry contains a signature", !logged.some((l) => signatures.some((s) => l.includes(s)) || /[0-9a-f]{100,}/.test(l)));
  check("no log entry contains card or customer values or a request body", !logged.some((l) => SENSITIVE_VALUES.some((v) => l.includes(v)) || l.includes('"event"') || l.includes("gateway_response")));

  console.log("\n== the harness cleaned up after itself ==");
  await iso.drop();
  const realAfter = await iso.realCounts();
  check("your real tables are exactly as they were (payment_log, subscriptions, webhook_events)", same(realBefore, realAfter), `${JSON.stringify(realBefore)} -> ${JSON.stringify(realAfter)}`);
  await iso.close();

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(inspect(error) + "\n");
  try { await iso?.drop(); await iso?.close(); } catch { /* ignore */ }
  process.exit(1);
});
