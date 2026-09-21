// Checks the pure Paystack pieces with NO database and NO network: the shared payment decision, the evidence
// trimming (no card or customer details may ever be kept), the verify and initialize clients against a fake
// Paystack, and the reference format. Uses the sanitized fixtures in scripts/fixtures/paystack/ (real
// payload structure, fake values).
//
// Run with: npm run check:paystack
import { readFileSync } from "fs";
import { join } from "path";
import { evaluateTransaction, type OrderTerms } from "../src/lib/checkout/evaluate";
import { initializeTransaction, verifyTransaction } from "../src/lib/paystack/client";
import { transactionEvidenceSchema } from "../src/lib/paystack/evidence";
import { checkoutReferenceSchema } from "../src/lib/validation/checkout";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "scripts", "fixtures", "paystack", name), "utf8"));
const verifyFixture = fixture("verify-success.json");
const webhookFixture = fixture("charge-success.json");
const REF = verifyFixture.data.reference as string;
const order: OrderTerms = { txRef: REF, amountKobo: 300000, currency: "NGN" };
const tx = (over: Partial<{ status: string; reference: string; amountKobo: number; currency: string }> = {}) => ({ status: "success", reference: REF, amountKobo: 300000, currency: "NGN", ...over });
const respond = (status: number, body: unknown) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const withData = (over: Record<string, unknown>) => ({ ...verifyFixture, data: { ...verifyFixture.data, ...over } });

// Values that must never appear in anything we store (all fake, taken from the fixture's sensitive objects).
const SENSITIVE_VALUES = ["AUTH_FAKE_0000", "SIG_FAKE_0000", "customer@example.com", "CUS_fake0000", "203.0.113.10"];
const SENSITIVE_KEYS = ["authorization", "authorization_code", "customer", "email", "last4", "bin", "signature", "ip_address", "metadata", "log", "fees", "source", "plan", "split", "card", "cvv", "pan"];
const EVIDENCE_KEYS = ["amount", "channel", "currency", "domain", "gateway_response", "id", "paid_at", "reference", "status"];

async function main() {
  console.log("== the shared decision: does what Paystack says match our order, and is it paid? ==");
  const ev = (over: Parameters<typeof tx>[0]) => evaluateTransaction(order, tx(over));
  check("success, exact match -> fulfil", ev({}).kind === "fulfil");
  for (const amount of [299999, 300001, 3000000, 0, 30000]) {
    const r = ev({ amountKobo: amount });
    check(`success but amount ${amount} -> mismatch (amount)`, r.kind === "mismatch" && r.field === "amount");
  }
  check("success but currency USD -> mismatch (currency)", (() => { const r = ev({ currency: "USD" }); return r.kind === "mismatch" && r.field === "currency"; })());
  check("wrong amount AND wrong currency -> mismatch, amount reported first", (() => { const r = ev({ amountKobo: 1, currency: "USD" }); return r.kind === "mismatch" && r.field === "amount"; })());
  for (const status of ["success", "failed", "abandoned", "reversed", "ongoing"]) {
    const r = ev({ status, reference: "pslice-someone-else" });
    check(`status ${status} but Paystack answered for another reference -> mismatch (reference), whatever the status`, r.kind === "mismatch" && r.field === "reference");
  }
  for (const [status, expected] of [["failed", "failed"], ["abandoned", "abandoned"], ["reversed", "reversed"]] as const) {
    const r = ev({ status });
    check(`status ${status} -> not paid (${expected})`, r.kind === "not_paid" && r.paystackStatus === expected && r.rawStatus === status);
  }
  check("failed with a wrong amount is still just 'not paid' (nothing was paid)", (() => { const r = ev({ status: "failed", amountKobo: 1 }); return r.kind === "not_paid" && r.paystackStatus === "failed"; })());
  for (const status of ["ongoing", "pending", "queued", "processing", "", "SUCCESS", "Success", " success", "success ", "successful", "paid"]) {
    const r = ev({ status });
    check(`unrecognised status ${JSON.stringify(status)} -> not paid (other), NEVER paid: only exactly "success" pays`, r.kind === "not_paid" && r.paystackStatus === "other", r.kind);
  }

  console.log("\n== evidence: only these 9 fields are ever kept, no card or customer details ==");
  const verified = await verifyTransaction(REF, "sk_test_x", { fetch: respond(200, verifyFixture) });
  check("the real-shaped verify response (34 data fields) parses", verified.ok);
  if (!verified.ok) throw new Error("fixture must verify");
  const evidence = verified.transaction.evidence;
  const evidenceText = JSON.stringify(evidence);
  check("verify: evidence has exactly the 9 whitelisted keys", JSON.stringify(Object.keys(evidence).sort()) === JSON.stringify(EVIDENCE_KEYS), Object.keys(evidence).sort().join(","));
  check("verify: evidence values are right (reference, 300000 kobo, NGN, status, id)", evidence.reference === REF && evidence.amount === 300000 && evidence.currency === "NGN" && evidence.status === "success" && verified.transaction.providerTransactionId === String(verifyFixture.data.id));
  check("verify: the input really did contain the sensitive objects (so this test is meaningful)", "authorization" in verifyFixture.data && "customer" in verifyFixture.data && SENSITIVE_VALUES.every((v) => JSON.stringify(verifyFixture).includes(v)));
  check("verify: NONE of those sensitive values appears in the evidence", SENSITIVE_VALUES.every((v) => !evidenceText.includes(v)));
  check("verify: NONE of the sensitive key names appears in the evidence", SENSITIVE_KEYS.every((k) => !(k in evidence)));
  check("evidence is small enough to store with every payment (< 600 bytes)", evidenceText.length < 600, `${evidenceText.length} bytes`);
  const fromWebhook = transactionEvidenceSchema.parse(webhookFixture.data);
  check("webhook: the same schema trims the webhook body's data to the same 9 keys", JSON.stringify(Object.keys(fromWebhook).sort()) === JSON.stringify(EVIDENCE_KEYS) && SENSITIVE_VALUES.every((v) => !JSON.stringify(fromWebhook).includes(v)));
  {
    // Structural guarantee: however many unknown or sensitive-looking fields Paystack adds, they are dropped.
    const noisy: Record<string, unknown> = { ...webhookFixture.data };
    for (let i = 0; i < 50; i++) noisy[`new_field_${i}`] = { card_number: "4084084084084081", cvv: "408", nested: { authorization_code: "AUTH_X", pan: "1" } };
    noisy.authorization_code = "AUTH_LEAK"; noisy.card = { last4: "4081" }; noisy.cvv = "123"; noisy.pan = "4084084084084081";
    const trimmed = transactionEvidenceSchema.parse(noisy);
    check("50 unknown fields plus card-like fields added: still exactly the 9 keys, nothing extra kept", JSON.stringify(Object.keys(trimmed).sort()) === JSON.stringify(EVIDENCE_KEYS) && !JSON.stringify(trimmed).includes("4084084084084081") && !JSON.stringify(trimmed).includes("AUTH_LEAK"));
  }
  {
    const lean = { id: 1, status: "abandoned", reference: REF, amount: 300000, currency: "NGN", paid_at: null };
    const t = transactionEvidenceSchema.parse(lean);
    check("optional fields may be absent or null (an abandoned transaction has paid_at null)", t.paid_at === null && !("channel" in t) && !("domain" in t));
    for (const [name, bad] of [["amount is a decimal", { ...lean, amount: 3000.5 }], ["amount is a string", { ...lean, amount: "300000" }], ["id is a string", { ...lean, id: "1" }], ["reference missing", { ...lean, reference: undefined }], ["currency missing", { ...lean, currency: undefined }], ["status missing", { ...lean, status: undefined }]] as const) {
      check(`required field wrong (${name}) -> rejected`, !transactionEvidenceSchema.safeParse(bad).success);
    }
  }

  console.log("\n== verify client against a fake Paystack ==");
  let seen: { url?: string; init?: RequestInit } = {};
  await verifyTransaction(REF, "sk_test_SECRET", { fetch: (async (u: string, i: RequestInit) => { seen = { url: u, init: i }; return new Response(JSON.stringify(verifyFixture)); }) as unknown as typeof fetch });
  check("GET /transaction/verify/<reference> with a Bearer header", seen.url === `https://api.paystack.co/transaction/verify/${REF}` && seen.init?.method === "GET" && (seen.init?.headers as Record<string, string>).Authorization === "Bearer sk_test_SECRET");
  const notFound = { status: false, message: "Transaction reference not found.", type: "validation_error", code: "transaction_not_found" };
  let r = await verifyTransaction(REF, "k", { fetch: respond(400, notFound) });
  check("HTTP 400 + code transaction_not_found -> not_found", !r.ok && r.kind === "not_found");
  r = await verifyTransaction(REF, "k", { fetch: respond(400, { ...notFound, code: "something_else" }) });
  check("HTTP 400 with the same English message but another code -> http_error (we match the code, not the text)", !r.ok && r.kind === "http_error");
  r = await verifyTransaction(REF, "k", { fetch: respond(404, notFound) });
  check("HTTP 404 -> http_error (only the observed 400 means 'not found')", !r.ok && r.kind === "http_error");
  for (const [s, b] of [[401, { status: false, message: "Invalid key" }], [429, "Too Many Requests"], [500, "<html>oops</html>"], [503, {}]] as const) {
    r = await verifyTransaction(REF, "k", { fetch: respond(s, b) });
    check(`HTTP ${s} -> http_error`, !r.ok && r.kind === "http_error" && r.httpStatus === s);
  }
  r = await verifyTransaction(REF, "k", { fetch: async () => { throw new TypeError("fetch failed"); } });
  check("network error -> network_error", !r.ok && r.kind === "network_error");
  r = await verifyTransaction(REF, "k", { fetch: async () => { throw new DOMException("timed out", "TimeoutError"); } });
  check("timeout -> network_error", !r.ok && r.kind === "network_error");
  const badShapes: [string, unknown][] = [
    ["not JSON", "hello"], ["outer status false", { ...verifyFixture, status: false }], ["no data", { status: true }],
    ["amount missing", withData({ amount: undefined })], ["amount a decimal", withData({ amount: 3000.5 })], ["amount a string", withData({ amount: "300000" })],
    ["id missing", withData({ id: undefined })], ["id a string", withData({ id: "2000000001" })], ["currency missing", withData({ currency: undefined })],
  ];
  for (const [name, body] of badShapes) {
    r = await verifyTransaction(REF, "k", { fetch: respond(200, body) });
    check(`HTTP 200 but ${name} -> bad_response`, !r.ok && r.kind === "bad_response");
    check(`   (${name}) the failure holds no response body and none of the card/customer values`, !r.ok && !("body" in r) && SENSITIVE_VALUES.every((v) => !JSON.stringify(r).includes(v)));
  }
  r = await verifyTransaction(REF, "k", { fetch: respond(200, withData({ status: "abandoned", paid_at: null, log: null }) ) });
  check("an abandoned transaction verifies fine and reports status 'abandoned' (never 'success')", r.ok && r.transaction.status === "abandoned" && r.transaction.evidence.paid_at === null);

  console.log("\n== initialize client against a fake Paystack ==");
  const input = { email: "a@example.com", amountKobo: 300000, currency: "NGN", reference: "pslice-test-1", callbackUrl: "http://localhost:3002/checkout/return" };
  const good = { status: true, message: "ok", data: { authorization_url: "https://checkout.paystack.com/abc123", access_code: "abc123", reference: input.reference } };
  let init = await initializeTransaction(input, "sk_test_x", { fetch: respond(200, good) });
  check("valid response -> ok with the URL", init.ok && init.authorizationUrl === "https://checkout.paystack.com/abc123");
  let iseen: { url?: string; init?: RequestInit } = {};
  await initializeTransaction(input, "sk_test_SECRET", { fetch: (async (u: string, i: RequestInit) => { iseen = { url: u, init: i }; return new Response(JSON.stringify(good)); }) as unknown as typeof fetch });
  const sent = JSON.parse(String(iseen.init?.body));
  check("POST /transaction/initialize with integer kobo, email, currency, reference, callback_url", iseen.url === "https://api.paystack.co/transaction/initialize" && Number.isInteger(sent.amount) && sent.amount === 300000 && sent.email && sent.currency === "NGN" && sent.reference === input.reference && sent.callback_url === input.callbackUrl);
  check("the secret key is only in the Authorization header, never in the body", (iseen.init?.headers as Record<string, string>).Authorization === "Bearer sk_test_SECRET" && !String(iseen.init?.body).includes("SECRET"));
  init = await initializeTransaction(input, "k", { fetch: async () => { throw new TypeError("fetch failed"); } });
  check("network error -> network_error", !init.ok && init.kind === "network_error");
  init = await initializeTransaction(input, "k", { fetch: async () => { throw new DOMException("timed out", "TimeoutError"); } });
  check("timeout -> network_error", !init.ok && init.kind === "network_error");
  for (const [s, b] of [[400, { status: false, message: "Invalid amount" }], [401, { status: false }], [429, "Too Many Requests"], [500, "<html>"]] as const) {
    init = await initializeTransaction(input, "k", { fetch: respond(s, b) });
    check(`HTTP ${s} -> http_error with the status`, !init.ok && init.kind === "http_error" && init.httpStatus === s);
  }
  for (const [name, body] of [["not JSON", "hello"], ["wrong shape", { status: true, data: {} }], ["status false", { status: false, data: good.data }], ["someone else's reference", { ...good, data: { ...good.data, reference: "someone-elses" } }]] as const) {
    init = await initializeTransaction(input, "k", { fetch: respond(200, body) });
    check(`HTTP 200 but ${name} -> bad_response`, !init.ok && init.kind === "bad_response");
  }
  for (const bad of ["http://checkout.paystack.com/x", "https://evil.example/pay", "https://paystack.com.evil.example/x", "javascript:alert(1)", "not a url"]) {
    init = await initializeTransaction(input, "k", { fetch: respond(200, { ...good, data: { ...good.data, authorization_url: bad } }) });
    check(`unsafe authorization_url rejected: ${bad}`, !init.ok && init.kind === "bad_response");
  }
  init = await initializeTransaction(input, "k", { fetch: respond(200, { ...good, data: { ...good.data, authorization_url: "https://paystack.com/pay/x" } }) });
  check("a bare paystack.com host is accepted", init.ok);
  init = await initializeTransaction(input, "k", { fetch: respond(400, "x".repeat(50000)) });
  check("a huge error body is capped before it can be stored", !init.ok && init.kind === "http_error" && JSON.stringify(init.body).length < 2100);

  console.log("\n== our payment reference format ==");
  const good1 = "pslice-33958ad1-3e4e-4fd9-b251-1b34ebe6924c";
  check(`accepts ${good1}`, checkoutReferenceSchema.safeParse(good1).success);
  const bad: string[] = ["", " ", "pslice-", good1.toUpperCase(), "PSLICE-" + good1.slice(7), "xslice-" + good1.slice(7), good1.slice(0, -1), good1 + "c", "pslice-../../x", "../" + good1, good1 + "\n", good1 + "/extra", "x".repeat(5000)];
  for (const v of bad) check(`rejects ${JSON.stringify(v.length > 60 ? v.slice(0, 20) + `...(${v.length} chars)` : v)}`, !checkoutReferenceSchema.safeParse(v).success);

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
