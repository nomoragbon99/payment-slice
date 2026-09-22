// Checks the plans and billing UI.
//
// Part 1 (no app needed): the pure logic, i.e. which plan a subscription row means, how dates are shown, and what the
// "Choose plan" button does with each answer from /api/checkout.
// Part 2 (needs the dev app on http://localhost:3002): the REAL pages rendered for every plan state, and the Cancel
// placeholder endpoint. It uses a throwaway user with a temporary subscription row and session, all removed afterwards.
// It never creates a payment or touches the payment ledger.
//
// Run with: npm run check:billing
import { randomUUID } from "crypto";
import { inspect } from "util";
import { db } from "../src/lib/db";
import { generateSessionToken, sha256Hex } from "../src/lib/auth/tokens";
import { describeSubscription, type SubscriptionRow } from "../src/lib/billing/subscription";
import { interpretCheckoutResponse } from "../src/lib/billing/checkout-client";
import { formatDate } from "../src/lib/format-date";

const BASE = "http://localhost:3002";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

async function main() {
  const now = new Date("2026-09-22T12:00:00Z");
  const row = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({ billingInterval: "monthly", status: "active", currentPeriodEnd: new Date("2026-11-21T20:18:41Z"), cancelAtPeriodEnd: false, ...over });

  console.log("== which plan a subscription row means ==");
  const v = (r: SubscriptionRow | null) => describeSubscription(r, now);
  check("no row -> Free (never subscribed)", (() => { const p = v(null); return p.kind === "free" && p.reason === "never_subscribed"; })());
  check("active monthly, period in the future -> Pro monthly, not ending", (() => { const p = v(row()); return p.kind === "pro" && p.interval === "monthly" && p.endsAtPeriodEnd === false && p.activeUntil.toISOString() === "2026-11-21T20:18:41.000Z"; })());
  check("active yearly -> Pro yearly", (() => { const p = v(row({ billingInterval: "yearly" })); return p.kind === "pro" && p.interval === "yearly"; })());
  check("active with cancel_at_period_end -> Pro, marked as ending", (() => { const p = v(row({ cancelAtPeriodEnd: true })); return p.kind === "pro" && p.endsAtPeriodEnd === true; })());
  check("active but the period ends EXACTLY now -> Free (expired): the period has ended", (() => { const p = v(row({ currentPeriodEnd: now })); return p.kind === "free" && p.reason === "expired"; })());
  check("active, period ends 1 ms from now -> still Pro", v(row({ currentPeriodEnd: new Date(now.getTime() + 1) })).kind === "pro");
  check("active but the period ended in the past -> Free (expired), remembering when", (() => { const p = v(row({ currentPeriodEnd: new Date("2026-09-01T00:00:00Z") })); return p.kind === "free" && p.reason === "expired" && p.endedOn?.toISOString() === "2026-09-01T00:00:00.000Z"; })());
  check("past_due, even with time left -> Free (past_due): no entitlement without payment", (() => { const p = v(row({ status: "past_due" })); return p.kind === "free" && p.reason === "past_due"; })());
  check("canceled, even with time left -> Free (canceled)", (() => { const p = v(row({ status: "canceled" })); return p.kind === "free" && p.reason === "canceled"; })());
  check("an unrecognised status never grants Pro", v(row({ status: "something-else" })).kind === "free");

  console.log("\n== dates are shown in UTC, the same everywhere ==");
  check("21 November 2026", formatDate(new Date("2026-11-21T20:18:41Z")) === "21 November 2026", formatDate(new Date("2026-11-21T20:18:41Z")));
  check("23:59:59 UTC is still that day", formatDate(new Date("2026-12-31T23:59:59Z")) === "31 December 2026");
  check("00:00:00 UTC is the new day", formatDate(new Date("2027-01-01T00:00:00Z")) === "1 January 2027");

  console.log("\n== what the 'Choose plan' button does with each answer from /api/checkout ==");
  const good = { authorizationUrl: "https://checkout.paystack.com/abc123" };
  const o = interpretCheckoutResponse;
  check("200 with a Paystack https URL -> redirect to it", (() => { const r = o(200, good); return r.action === "redirect" && r.url === good.authorizationUrl; })());
  for (const bad of ["http://checkout.paystack.com/x", "https://evil.example/pay", "https://paystack.com.evil.example/x", "javascript:alert(1)", "not a url", "", "//checkout.paystack.com/x"]) {
    check(`200 with an unsafe URL is NOT followed: ${JSON.stringify(bad)}`, o(200, { authorizationUrl: bad }).action === "message");
  }
  check("200 with the URL missing, null, a number or an object -> message", [o(200, {}), o(200, null), o(200, { authorizationUrl: 5 }), o(200, { authorizationUrl: {} }), o(200, "text")].every((r) => r.action === "message"));
  check("401 -> go and sign in", o(401, { error: {} }).action === "sign_in");
  check("409 -> 'You already have an active plan.'", (() => { const r = o(409, { error: { code: "ALREADY_SUBSCRIBED" } }); return r.action === "message" && r.text === "You already have an active plan."; })());
  check("429 with Retry-After 45 -> '45 seconds'", (() => { const r = o(429, null, "45"); return r.action === "message" && r.text.includes("45 seconds"); })());
  check("429 with Retry-After 240 -> '4 minutes'", (() => { const r = o(429, null, "240"); return r.action === "message" && r.text.includes("4 minutes"); })());
  check("429 with a missing or nonsense Retry-After -> 'a little while'", [o(429, null, null), o(429, null, "abc"), o(429, null, "-5")].every((r) => r.action === "message" && r.text.includes("a little while")));
  check("502 and 503 -> 'couldn't start the payment'", [o(502, null), o(503, null)].every((r) => r.action === "message" && r.text.includes("couldn't start the payment")));
  check("400, 403, 404, 418, 500 -> a generic message, never the server's text", [400, 403, 404, 418, 500].every((s) => { const r = o(s, { error: { message: "SECRET DETAIL" } }); return r.action === "message" && !r.text.includes("SECRET"); }));

  console.log("\n== the real pages (needs the dev app on port 3002) ==");
  const up = await fetch(`${BASE}/sign-in`, { redirect: "manual" }).then((r) => r.status === 200).catch(() => false);
  if (!up) {
    console.log(`SKIP  the app is not answering on ${BASE}: start it with 'npm run dev' and run this again to check the pages`);
    finish();
    return;
  }

  const email = `check-billing-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, name: "Billing Check", passwordHash: "not-a-real-hash" } });
  const token = generateSessionToken();
  await db.session.create({ data: { id: sha256Hex(token), userId: user.id, expiresAt: new Date(Date.now() + 3600_000) } });
  const cookie = `payment_slice_session=${token}`;

  const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const page = async (path: string) => { const r = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" }); const html = await r.text(); return { status: r.status, html, text: text(html) }; };
  const setSub = async (status: string, interval: string, endOffsetDays: number, extra: { cancelAtPeriodEnd?: boolean; reason?: string } = {}) => {
    await db.subscription.deleteMany({ where: { userId: user.id } });
    const end = new Date(Date.now() + endOffsetDays * 24 * 3600_000);
    await db.subscription.create({ data: { userId: user.id, planId: "pro", billingInterval: interval, status, currentPeriodStart: new Date(end.getTime() - 30 * 24 * 3600_000), currentPeriodEnd: end, cancelAtPeriodEnd: extra.cancelAtPeriodEnd ?? false, cancellationReason: extra.reason ?? null, lastTxRef: "pslice-check-billing" } });
    return end;
  };
  const count = (s: string, needle: string) => s.split(needle).length - 1;
  // The text of whichever <section> is marked aria-current="true" (there must be exactly one), so we can
  // confirm the CORRECT plan is marked current, not just that some row is.
  const currentRowText = (html: string) => {
    const m = html.match(/<section aria-current="true"[\s\S]*?<\/section>/);
    return m ? text(m[0]).trim() : "";
  };

  try {
    console.log("-- signed out");
    for (const path of ["/plans", "/billing"]) {
      const r = await fetch(`${BASE}${path}`, { redirect: "manual" });
      check(`${path} without a session -> redirected to sign-in, remembering the page`, r.status === 307 && (r.headers.get("location") ?? "").includes(`/sign-in?next=${encodeURIComponent(path)}`), `${r.status} ${r.headers.get("location")}`);
      const forged = await fetch(`${BASE}${path}`, { headers: { cookie: "payment_slice_session=forgedforgedforgedforgedforgedforged" }, redirect: "manual" });
      check(`${path} with a forged cookie -> also redirected to sign-in`, forged.status === 307 && (forged.headers.get("location") ?? "").includes("/sign-in"));
    }

    console.log("-- Free (no subscription row)");
    await db.subscription.deleteMany({ where: { userId: user.id } });
    let p = await page("/plans");
    check("/plans: 200; Free is the ONE current plan; both paid options can be chosen", p.status === 200 && count(p.html, 'aria-current="true"') === 1 && currentRowText(p.html).startsWith("Free") && currentRowText(p.html).includes("Current plan") && p.text.includes("Choose monthly") && p.text.includes("Choose yearly") && !p.text.includes("Available"));
    check("/plans: prices come from the plan config (₦3,000.00 / month, ₦30,000.00 / year)", p.text.includes("₦3,000.00 / month") && p.text.includes("₦30,000.00 / year"));
    let b = await page("/billing");
    check("/billing: \"You're on the Free plan.\", no cancel control, a link to the plans", b.status === 200 && b.text.includes("You're on the Free plan.") && !b.text.includes("Cancel plan") && b.html.includes('href="/plans"'));

    console.log("-- Pro monthly, active");
    let end = await setSub("active", "monthly", 20);
    p = await page("/plans");
    check("/plans: Pro (monthly) is the ONE current plan and shows when it is active until", count(p.html, 'aria-current="true"') === 1 && currentRowText(p.html).startsWith("Pro (monthly)") && currentRowText(p.html).includes(`Active until ${formatDate(end)}`));
    check("/plans: the OTHER paid option is not a button (checkout would answer 409); it says when it becomes available", !p.text.includes("Choose monthly") && !p.text.includes("Choose yearly") && p.text.includes(`Available ${formatDate(end)}`) && !currentRowText(p.html).startsWith("Free"));
    b = await page("/billing");
    check("/billing: Pro (monthly), Active, 'Active until' the right date, and a Cancel control", b.text.includes("Pro (monthly)") && /Status\s+Active\b/.test(b.text) && b.text.includes(`Active until ${formatDate(end)}`) && b.text.includes("Cancel plan"));
    check("/billing never says 'Renews': there is no automatic renewal", !/renew/i.test(b.text));

    console.log("-- Pro yearly, active");
    end = await setSub("active", "yearly", 300);
    p = await page("/plans");
    check("/plans: Pro (yearly) is current; monthly is not offered as a button", count(p.html, 'aria-current="true"') === 1 && currentRowText(p.html).startsWith("Pro (yearly)") && !p.text.includes("Choose monthly") && !p.text.includes("Choose yearly") && p.text.includes("Available"));
    b = await page("/billing");
    check("/billing: Pro (yearly) with its end date", b.text.includes("Pro (yearly)") && b.text.includes(`Active until ${formatDate(end)}`));

    console.log("-- Pro, set to end (cancel_at_period_end)");
    end = await setSub("active", "monthly", 10, { cancelAtPeriodEnd: true, reason: "too expensive" });
    b = await page("/billing");
    check("/billing: says it will end on the date and offers no second Cancel", b.text.includes("Active, will end") && b.text.includes(`Ends on ${formatDate(end)}`) && b.text.includes(`Your plan will end on ${formatDate(end)}.`) && !b.text.includes("Cancel plan"));

    console.log("-- not entitled any more: expired, past due, canceled");
    for (const [name, status, days, expected] of [["active but the period ended", "active", -3, "Your Pro plan ended on"], ["past_due", "past_due", 5, "Your Pro plan is past due."], ["canceled", "canceled", 5, "Your Pro plan was canceled."]] as const) {
      await setSub(status, "monthly", days);
      p = await page("/plans"); b = await page("/billing");
      check(`${name}: /plans shows Free as current and both paid options can be chosen`, count(p.html, 'aria-current="true"') === 1 && currentRowText(p.html).startsWith("Free") && p.text.includes("Choose monthly") && p.text.includes("Choose yearly"));
      check(`${name}: /billing says "You're on the Free plan." with '${expected}', and no Cancel control`, b.text.includes("You're on the Free plan.") && b.text.includes(expected) && !b.text.includes("Cancel plan"));
    }

    console.log("-- the dashboard links to both pages");
    const d = await page("/dashboard");
    check("/dashboard links to /plans and /billing", d.status === 200 && d.html.includes('href="/plans"') && d.html.includes('href="/billing"'));

    console.log("-- the Cancel placeholder endpoint: POST /api/subscription/cancel");
    const post = (body: string | undefined, headers: Record<string, string> = {}, method = "POST") => fetch(`${BASE}/api/subscription/cancel`, { method, headers: { "content-type": "application/json", origin: BASE, ...headers }, body });
    let r = await post("{}", { cookie: "" });
    check("no session -> 401", r.status === 401);
    r = await post("{}", { cookie, origin: "https://evil.example" });
    check("a foreign Origin -> 403", r.status === 403);
    r = await post("{}", { cookie });
    const j = await r.json();
    check("signed in, empty body -> 501 NOT_IMPLEMENTED (the cancellation itself is the next task)", r.status === 501 && j.error?.code === "NOT_IMPLEMENTED");
    r = await post(undefined, { cookie });
    check("signed in, no body at all -> 501 too", r.status === 501);
    r = await post(JSON.stringify({ reason: "too expensive" }), { cookie });
    check("signed in, with a valid reason -> 501", r.status === 501);
    r = await post(JSON.stringify({ reason: "r".repeat(500) }), { cookie });
    check("a reason of exactly 500 characters is allowed (the database limit) -> 501", r.status === 501);
    for (const [name, body] of [["a 501-character reason", JSON.stringify({ reason: "r".repeat(501) })], ["an empty reason", JSON.stringify({ reason: "" })], ["a blank reason", JSON.stringify({ reason: "   " })], ["a reason that is not text", JSON.stringify({ reason: 5 })], ["an unexpected extra key", JSON.stringify({ reason: "x", planId: "free" })], ["invalid JSON", "not json"]] as const) {
      r = await post(body, { cookie });
      check(`${name} -> 400, nothing about the server's internals`, r.status === 400);
    }
    r = await post(undefined, { cookie }, "GET");
    check("GET is not allowed -> 405", r.status === 405);
    check("the placeholder changed nothing: the subscription row is still there, untouched", (await db.subscription.count({ where: { userId: user.id } })) === 1);
  } finally {
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }
  const left = (await db.user.count({ where: { email } })) + (await db.subscription.count({ where: { lastTxRef: "pslice-check-billing" } }));
  check("the throwaway user, session and subscription are gone", left === 0);
  finish();
}

async function finish() {
  await db.$disconnect();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(inspect(error) + "\n");
  await db.$disconnect();
  process.exit(1);
});
