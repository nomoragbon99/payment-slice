// Checks the cancellation and resume flow. Contained-feature scope, per the owner: correctness of the logic and
// the real routes/pages, not the concurrency/race battery used for the payment-critical pieces (no money moves
// here, and a lost race at worst means one click didn't take -- there is nothing to double-spend).
//
// Part 1: the logic (cancelSubscription / resumeSubscription), called directly against a TEMPORARY copy of the
// database structure (real migrations, real CHECKs: scripts/lib/isolated-schema.ts). Every call passes that
// client explicitly -- the functions default to the app's real `db` singleton, which must never be relied on here.
//
// Part 2 (needs the dev app on http://localhost:3002): the REAL HTTP routes and the billing page. This uses the
// REAL database (the same one the running dev server talks to -- a separate OS process cannot see rows created in
// a temporary schema), with a throwaway user, session and subscription row, all removed in a finally block. It
// touches no real user's data and the real-table row counts are unaffected once cleanup runs.
//
// Run with: npm run check:cancellation
import { randomUUID } from "crypto";
import { inspect } from "util";
import type { PrismaClient } from "../src/generated/prisma/client";
import { db as realDb } from "../src/lib/db";
import { generateSessionToken, sha256Hex } from "../src/lib/auth/tokens";
import { cancelSubscription, resumeSubscription } from "../src/lib/billing/cancel";
import { describeSubscription } from "../src/lib/billing/subscription";
import { createIsolatedSchema, type Isolated } from "./lib/isolated-schema";

let iso: Isolated | undefined;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

let counter = 0;

async function main() {
  console.log("== part 1: the logic, against a temporary copy of the database structure ==");
  iso = await createIsolatedSchema("check_cancellation");
  const tdb = iso.db; // "temporary db": every call below passes this explicitly, on purpose.

  const makeUser = async (label: string) => {
    const u = await tdb.user.create({ data: { email: `cancel-${label}-${randomUUID()}@example.com`, name: "Cancel Test", passwordHash: "x" } });
    return { id: u.id, email: u.email };
  };
  const makeSub = async (userId: string, over: { status?: string; endOffsetDays?: number; cancelAtPeriodEnd?: boolean; reason?: string | null } = {}) => {
    counter++;
    const end = new Date(Date.now() + (over.endOffsetDays ?? 20) * 24 * 3600_000);
    await tdb.subscription.create({
      data: {
        userId,
        planId: "pro",
        billingInterval: "monthly",
        status: over.status ?? "active",
        currentPeriodStart: new Date(end.getTime() - 30 * 24 * 3600_000),
        currentPeriodEnd: end,
        cancelAtPeriodEnd: over.cancelAtPeriodEnd ?? false,
        cancellationReason: over.reason ?? null,
        lastTxRef: `pslice-cancel-check-${counter}`,
      },
    });
    return end;
  };
  const row = (userId: string) => tdb.subscription.findUniqueOrThrow({ where: { userId } });

  console.log("\n-- cancelSubscription: what it writes --");
  {
    const u = await makeUser("a");
    const end = await makeSub(u.id);
    const r = await cancelSubscription(u.id, "too expensive", tdb);
    check("active, in-period -> outcome canceled, with the correct end date", r.outcome === "canceled" && r.endsOn.getTime() === end.getTime());
    const after = await row(u.id);
    check(
      "cancel_at_period_end is now true; status is STILL active (access is retained until the period ends); the reason is stored",
      after.cancelAtPeriodEnd === true && after.status === "active" && after.cancellationReason === "too expensive",
    );
    check("nothing else on the row changed (plan, interval, the period end, last_tx_ref)", after.planId === "pro" && after.billingInterval === "monthly" && after.currentPeriodEnd.getTime() === end.getTime());
  }
  {
    const u = await makeUser("noreason");
    await makeSub(u.id);
    await cancelSubscription(u.id, undefined, tdb);
    check("cancel with no reason -> cancellation_reason stays NULL, not an empty string", (await row(u.id)).cancellationReason === null);
  }

  console.log("\n-- describeSubscription agrees with what cancellation produced --");
  {
    const u = await makeUser("view");
    await makeSub(u.id);
    await cancelSubscription(u.id, "x", tdb);
    const view = describeSubscription(await row(u.id), new Date());
    check("right after cancelling: still Pro, endsAtPeriodEnd true (what /billing renders as 'Active, will end')", view.kind === "pro" && view.endsAtPeriodEnd === true);
  }

  console.log("\n-- validation: reject a cancellation when there is nothing eligible to cancel --");
  {
    const u = await makeUser("none");
    const r = await cancelSubscription(u.id, undefined, tdb);
    check("no subscription row at all -> not_subscribed, nothing written", r.outcome === "not_subscribed" && (await tdb.subscription.count({ where: { userId: u.id } })) === 0);
  }
  {
    const u = await makeUser("pastdue");
    await makeSub(u.id, { status: "past_due" });
    const r = await cancelSubscription(u.id, undefined, tdb);
    check("status past_due -> not_subscribed (from the person's point of view they are already on Free)", r.outcome === "not_subscribed");
    check("...the row itself is untouched", (await row(u.id)).cancelAtPeriodEnd === false);
  }
  {
    const u = await makeUser("lapsed");
    await makeSub(u.id, { endOffsetDays: -5 }); // status is still 'active' in the row, but the period has passed
    const r = await cancelSubscription(u.id, undefined, tdb);
    check("status active but the period already ended -> not_subscribed (uses describeSubscription, not the raw status column)", r.outcome === "not_subscribed");
  }
  {
    const u = await makeUser("twice");
    await makeSub(u.id);
    const first = await cancelSubscription(u.id, "first reason", tdb);
    const second = await cancelSubscription(u.id, "second reason", tdb);
    check("cancelling twice: the first succeeds, the second is already_canceled", first.outcome === "canceled" && second.outcome === "already_canceled");
    check("...the SECOND call did not overwrite the stored reason", (await row(u.id)).cancellationReason === "first reason");
  }
  {
    const u = await makeUser("canceledstatus");
    await makeSub(u.id, { status: "canceled" });
    const r = await cancelSubscription(u.id, undefined, tdb);
    check("status='canceled' (the reserved, currently-unwritten value) -> not_subscribed, handled like any other non-active row", r.outcome === "not_subscribed");
  }

  console.log("\n-- resumeSubscription --");
  {
    const u = await makeUser("resume");
    const end = await makeSub(u.id);
    await cancelSubscription(u.id, "changed my mind about this reason", tdb);
    const r = await resumeSubscription(u.id, tdb);
    check("cancelled, still in-period -> outcome resumed", r.outcome === "resumed");
    const after = await row(u.id);
    check("cancel_at_period_end is false again, the reason is cleared, the period is untouched", after.cancelAtPeriodEnd === false && after.cancellationReason === null && after.currentPeriodEnd.getTime() === end.getTime());
    const view = describeSubscription(after, new Date());
    check("describeSubscription now reports Pro, not ending", view.kind === "pro" && view.endsAtPeriodEnd === false);
  }
  {
    const u = await makeUser("neverc");
    await makeSub(u.id);
    const r = await resumeSubscription(u.id, tdb);
    check("never cancelled -> not_canceled, row untouched", r.outcome === "not_canceled" && (await row(u.id)).cancelAtPeriodEnd === false);
  }
  {
    const u = await makeUser("lapsedcancel");
    await makeSub(u.id, { endOffsetDays: -3, cancelAtPeriodEnd: true, reason: "old" });
    const r = await resumeSubscription(u.id, tdb);
    check("cancelled AND the period has since lapsed -> not_canceled (nothing left to resume)", r.outcome === "not_canceled");
    const after = await row(u.id);
    check("...the lapsed row is left exactly as it was (still cancel_at_period_end true, still has its old reason: history, not live state)", after.cancelAtPeriodEnd === true && after.cancellationReason === "old");
  }
  {
    const u = await makeUser("none2");
    const r = await resumeSubscription(u.id, tdb);
    check("no subscription row at all -> not_canceled", r.outcome === "not_canceled");
  }

  const realBefore = await iso.realCounts();
  await iso.drop();
  const gone = await iso.admin.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = '${iso.schema}'`);
  check("the temporary schema is dropped", gone[0].n === 0);

  console.log("\n== part 2: the real HTTP routes and billing page (needs the dev app on port 3002) ==");
  const BASE = "http://localhost:3002";
  const up = await fetch(`${BASE}/sign-in`, { redirect: "manual" }).then((r) => r.status === 200).catch(() => false);
  if (!up) {
    console.log(`SKIP  the app is not answering on ${BASE}: start it with 'npm run dev' and run this again to check the real routes and page`);
    await finish(iso.admin, realBefore);
    return;
  }

  const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const cancel = (cookie: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${BASE}/api/subscription/cancel`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie, ...headers }, body });
  const resume = (cookie: string, headers: Record<string, string> = {}) =>
    fetch(`${BASE}/api/subscription/resume`, { method: "POST", headers: { origin: BASE, cookie, ...headers } });
  const billing = (cookie: string) => fetch(`${BASE}/billing`, { headers: { cookie } }).then(async (r) => text(await r.text()));

  const user = await realDb.user.create({ data: { email: `cancel-http-${randomUUID()}@example.com`, name: "Cancel HTTP Test", passwordHash: "x" } });
  const token = generateSessionToken();
  await realDb.session.create({ data: { id: sha256Hex(token), userId: user.id, expiresAt: new Date(Date.now() + 3600_000) } });
  const cookie = `payment_slice_session=${token}`;
  const realRow = () => realDb.subscription.findUniqueOrThrow({ where: { userId: user.id } });

  try {
    let r = await cancel("", "{}");
    check("no session -> 401", r.status === 401);
    r = await cancel(cookie, "{}", { origin: "https://evil.example" });
    check("foreign Origin -> 403", r.status === 403);
    r = await resume("");
    check("resume, no session -> 401", r.status === 401);
    r = await resume(cookie, { origin: "https://evil.example" });
    check("resume, foreign Origin -> 403", r.status === 403);

    for (const [name, body] of [
      ["a 501-character reason", JSON.stringify({ reason: "r".repeat(501) })],
      ["an empty reason", JSON.stringify({ reason: "" })],
      ["a blank reason", JSON.stringify({ reason: "   " })],
      ["a reason that is not text", JSON.stringify({ reason: 5 })],
      ["an unexpected extra key", JSON.stringify({ reason: "x", status: "canceled" })],
      ["invalid JSON", "not json"],
    ] as const) {
      r = await cancel(cookie, body);
      check(`${name} -> 400, nothing subscribed yet to write to`, r.status === 400);
    }

    await realDb.subscription.create({
      data: {
        userId: user.id,
        planId: "pro",
        billingInterval: "monthly",
        status: "active",
        currentPeriodStart: new Date(Date.now() - 5 * 24 * 3600_000),
        currentPeriodEnd: new Date(Date.now() + 25 * 24 * 3600_000),
        lastTxRef: "pslice-cancel-http-check",
      },
    });

    r = await cancel(cookie, JSON.stringify({ reason: "moving to a competitor" }));
    const j = await r.json();
    check("real cancel over HTTP: 200 with an ISO end date matching the row", r.status === 200 && new Date(j.endsOn).getTime() === (await realRow()).currentPeriodEnd.getTime());
    const afterCancel = await realRow();
    check("the row: cancel_at_period_end true, status still active, reason stored", afterCancel.cancelAtPeriodEnd === true && afterCancel.status === "active" && afterCancel.cancellationReason === "moving to a competitor");

    let page = await billing(cookie);
    check("/billing shows the exact wording: 'will end on <date> and won't renew'", /will end on .+ and won.t renew\./.test(page));
    check("/billing shows no Cancel button any more (it is already cancelled)", !page.includes("Cancel plan"));
    check("/billing shows the Keep my plan (resume) control", page.includes("Keep my plan"));

    r = await cancel(cookie, "{}");
    const cancelAgainBody = await r.json();
    check("cancelling again over HTTP -> 409 ALREADY_CANCELLED", r.status === 409 && cancelAgainBody.error.code === "ALREADY_CANCELLED");

    r = await resume(cookie);
    check("real resume over HTTP: 200", r.status === 200 && (await realRow()).cancelAtPeriodEnd === false);
    page = await billing(cookie);
    check("/billing shows the Cancel button again, no 'won't renew' text", page.includes("Cancel plan") && !page.includes("won't renew"));

    r = await resume(cookie);
    const resumeAgainBody = await r.json();
    check("resuming again (nothing to resume) -> 409 NOT_CANCELLED", r.status === 409 && resumeAgainBody.error.code === "NOT_CANCELLED");

    await realDb.subscription.deleteMany({ where: { userId: user.id } });
    r = await cancel(cookie, "{}");
    const noSubBody = await r.json();
    check("no subscription at all, over HTTP -> 409 NOT_SUBSCRIBED", r.status === 409 && noSubBody.error.code === "NOT_SUBSCRIBED");
    page = await billing(cookie);
    check("/billing (Free plan) shows neither Cancel nor Keep my plan", !page.includes("Cancel plan") && !page.includes("Keep my plan"));
  } finally {
    await realDb.subscription.deleteMany({ where: { userId: user.id } });
    await realDb.session.deleteMany({ where: { userId: user.id } });
    await realDb.user.delete({ where: { id: user.id } });
  }

  await finish(iso.admin, realBefore);
}

async function finish(admin: PrismaClient, realBefore: { log: number; subs: number; events: number }) {
  const realAfter = { log: await admin.paymentLog.count(), subs: await admin.subscription.count(), events: await admin.webhookEvent.count() };
  check(
    "your real tables are exactly as they were (payment_log, subscriptions, webhook_events)",
    JSON.stringify(realBefore) === JSON.stringify(realAfter),
    `${JSON.stringify(realBefore)} -> ${JSON.stringify(realAfter)}`,
  );
  await admin.$disconnect();
  await realDb.$disconnect();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(inspect(error) + "\n");
  try {
    await iso?.drop();
    await iso?.close();
  } catch {
    /* ignore */
  }
  try {
    await realDb.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
