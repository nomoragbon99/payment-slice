import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { evaluateTransaction } from "@/lib/checkout/evaluate";
import { orderFromInitiatedRow, type OrderSummary } from "@/lib/checkout/order";
import { db } from "@/lib/db";
import { appendPaymentLog } from "@/lib/payment-log";
import { verifyTransaction, type VerifiedTransaction } from "@/lib/paystack/client";
import type { TransactionEvidence } from "@/lib/paystack/evidence";
import { checkoutReferenceSchema } from "@/lib/validation/checkout";

// THE one place a payment turns into a subscription. Both callers use it: the Paystack webhook and the
// /checkout/return page. Neither of them decides anything: a redirect or a webhook body only NAMES a
// reference. Whether it activates a plan is decided here, from Paystack's own answer to a server-to-server
// call made with our secret key, checked against the order we recorded before the customer could pay.
//
// Order of work, and why:
//   1. our own records: is this reference ours (and, for the page, this person's)? already fulfilled?
//   2. ALWAYS ask Paystack (GET verify), outside any database lock (a network call must not hold one)
//   3. evaluate.ts: paid AND reference, amount and currency exactly as recorded?
//   4. only then, in ONE database transaction under a per-reference lock: re-check the ledger, write the
//      'verified' and 'fulfilled' rows, activate the subscription, and (webhooks) record the event.
//
// Safe when both callers arrive together, in either order: the lock makes them run one after the other, the
// re-check inside the lock makes the second a no-op, and the partial unique indexes on payment_log are the
// last backstop if both of those were ever bypassed.

export type FulfilSource = "webhook" | "return_page";

// Only the trimmed evidence is ever kept (see src/lib/paystack/evidence.ts): never the full webhook body.
export type WebhookEventInput = {
  eventType: string;
  providerTransactionId: string;
  providerStatus: string;
  txRef: string;
  payload: TransactionEvidence;
};

export type FulfilInput = {
  reference: string;
  source: FulfilSource;
  // The page passes the signed-in person, so nobody can trigger or see anyone else's payment. A webhook has
  // no user: the subscription always goes to the user on OUR 'initiated' row, never to a caller-supplied one.
  expectedUserId?: string;
  secretKey: string | undefined;
  // Required when source is "webhook".
  webhookEvent?: WebhookEventInput;
};

export type FulfilResult =
  | { outcome: "fulfilled"; order: OrderSummary }
  | { outcome: "already_fulfilled"; order: OrderSummary }
  // Nothing was paid (or not yet): abandoned, failed, reversed or an unrecognised status. Nothing is written
  // for the page; a webhook records that it could not be verified.
  | { outcome: "not_paid"; order: OrderSummary; paystackStatus: "failed" | "abandoned" | "reversed" | "other"; rawStatus: string }
  | { outcome: "mismatch"; order: OrderSummary; field: "reference" | "amount" | "currency" }
  // "not_ours": no such reference for this caller. "provider_not_found": it is ours, but Paystack has no such transaction.
  | { outcome: "unknown"; reason: "not_ours" | "provider_not_found" }
  // Could not find out (Paystack unreachable, erroring, or answering nonsense): nothing written, retry later.
  | { outcome: "cannot_verify"; kind: "network_error" | "http_error" | "bad_response" | "not_configured" }
  // Paystack confirmed the payment but our own write failed and was rolled back entirely: retry later.
  | { outcome: "write_failed"; order: OrderSummary }
  // A webhook delivery we have already processed.
  | { outcome: "duplicate_event" };

// What webhook_events.outcome can hold (a CHECK constraint enforces the same list).
type WebhookOutcome = "fulfilled" | "already_fulfilled" | "verification_failed" | "amount_mismatch" | "unknown_tx_ref";

type Deps = {
  db?: PrismaClient;
  fetch?: typeof fetch;
  // Tests only: pin "now" (e.g. to check month-end arithmetic). In production this is left out and every
  // time comes from the database clock.
  now?: Date;
};

const PROVIDER = "paystack" as const;
const LOCK_TIMEOUTS = { maxWait: 5_000, timeout: 15_000 };

export async function fulfilTransaction(input: FulfilInput, deps: Deps = {}): Promise<FulfilResult> {
  const client = deps.db ?? db;
  const event = input.source === "webhook" ? input.webhookEvent : undefined;
  if (input.source === "webhook" && !event) throw new Error("A webhook call must carry its event details.");

  // 0. A delivery we already processed (Paystack may send the same event again): nothing to do, and no Paystack call.
  if (event && (await eventAlreadyRecorded(client, event))) return { outcome: "duplicate_event" };

  // 1. The reference is untrusted input: it must look exactly like one of ours...
  const parsed = checkoutReferenceSchema.safeParse(input.reference);
  if (!parsed.success) return notOurs(client, event);
  const txRef = parsed.data;

  // ...and match one of OUR 'initiated' rows (for the page: this person's own).
  const rows = await client.paymentLog.findMany({
    where: { txRef, ...(input.expectedUserId ? { userId: input.expectedUserId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  const initiated = rows.find((row) => row.eventType === "initiated");
  if (!initiated) return notOurs(client, event);
  const order = orderFromInitiatedRow(initiated);

  // Already fulfilled: our ledger records an earlier independent verification. No Paystack call.
  if (rows.some((row) => row.eventType === "fulfilled")) {
    await recordEvent(client, event, "already_fulfilled");
    return { outcome: "already_fulfilled", order };
  }

  // 2. Ask Paystack. Never trust a webhook body or a redirect for this.
  if (!input.secretKey) {
    console.error("fulfil: PAYSTACK_SECRET_KEY is not set; cannot verify payments.");
    return { outcome: "cannot_verify", kind: "not_configured" };
  }
  const verified = await verifyTransaction(txRef, input.secretKey, { fetch: deps.fetch });
  if (!verified.ok) {
    if (verified.kind === "not_found") return { outcome: "unknown", reason: "provider_not_found" };
    console.error("fulfil: could not verify with Paystack:", { txRef, kind: verified.kind });
    return { outcome: "cannot_verify", kind: verified.kind };
  }
  const paystack = verified.transaction;

  // 3. Is it paid, and exactly the order we recorded?
  const evaluation = evaluateTransaction(order, paystack);
  switch (evaluation.kind) {
    case "not_paid":
      await recordEvent(client, event, "verification_failed");
      return { outcome: "not_paid", order, paystackStatus: evaluation.paystackStatus, rawStatus: evaluation.rawStatus };
    case "mismatch":
      return recordMismatch(client, { txRef, userId: initiated.userId, order, paystack, field: evaluation.field, event, source: input.source });
    case "fulfil":
      // 4. Fulfil.
      return commitFulfilment(client, {
        userId: initiated.userId,
        order,
        interval: initiated.billingInterval,
        paystack,
        event,
        source: input.source,
        now: deps.now,
      });
  }
}

// ---------------------------------------------------------------------------------------------------------

async function eventAlreadyRecorded(client: PrismaClient, event: WebhookEventInput): Promise<boolean> {
  const existing = await client.webhookEvent.findUnique({
    where: {
      provider_eventType_providerTransactionId_providerStatus: {
        provider: PROVIDER,
        eventType: event.eventType,
        providerTransactionId: event.providerTransactionId,
        providerStatus: event.providerStatus,
      },
    },
    select: { id: true },
  });
  return existing !== null;
}

async function notOurs(client: PrismaClient, event: WebhookEventInput | undefined): Promise<FulfilResult> {
  await recordEvent(client, event, "unknown_tx_ref");
  return { outcome: "unknown", reason: "not_ours" };
}

// Records that a webhook was received and what we did about it. A no-op when there is no event (the page) and
// when the same event is already recorded (idempotency: the unique key decides, not a check-then-insert).
async function recordEvent(
  client: Pick<Prisma.TransactionClient, "webhookEvent">,
  event: WebhookEventInput | undefined,
  outcome: WebhookOutcome,
): Promise<void> {
  if (!event) return;
  await client.webhookEvent.createMany({
    data: [eventRow(event, outcome)],
    skipDuplicates: true,
  });
}

function eventRow(event: WebhookEventInput, outcome: WebhookOutcome) {
  return {
    provider: PROVIDER,
    eventType: event.eventType,
    providerTransactionId: event.providerTransactionId,
    providerStatus: event.providerStatus,
    txRef: event.txRef,
    payload: event.payload as Prisma.InputJsonValue,
    processedAt: new Date(),
    outcome,
  };
}

// One advisory lock per reference, held until the transaction ends: two callers for the same reference run
// strictly one after the other. (Selecting from a subquery because Prisma cannot read the void the function returns.)
async function lockReference(tx: Prisma.TransactionClient, txRef: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"fulfil:" + txRef}, 0))) AS l`;
}

function asInterval(value: string): "monthly" | "yearly" {
  if (value === "monthly" || value === "yearly") return value;
  throw new Error(`Unexpected billing interval on an initiated row: ${value}`);
}

type MismatchArgs = {
  txRef: string;
  userId: string;
  order: OrderSummary;
  paystack: VerifiedTransaction;
  field: "reference" | "amount" | "currency";
  event: WebhookEventInput | undefined;
  source: FulfilSource;
};

// Paid, but not the order we recorded. Nothing is activated. One 'failed' row records it, once per reference
// however many times the page is visited or the webhook is redelivered.
async function recordMismatch(client: PrismaClient, a: MismatchArgs): Promise<FulfilResult> {
  try {
    await client.$transaction(async (tx) => {
      await lockReference(tx, a.txRef);
      const already = await tx.paymentLog.findFirst({
        where: { txRef: a.txRef, eventType: "failed", rawResponse: { path: ["reason"], equals: "mismatch" } },
        select: { id: true },
      });
      if (!already) {
        // The money columns must satisfy the table's own rules; a nonsensical reported amount or currency is
        // kept in the evidence, and our own recorded terms are used for the columns.
        const reportedOk = Number.isInteger(a.paystack.amountKobo) && a.paystack.amountKobo > 0 && /^[A-Z]{3}$/.test(a.paystack.currency);
        await appendPaymentLog(
          {
            userId: a.userId,
            provider: PROVIDER,
            planId: "pro",
            billingInterval: asInterval(a.order.billingInterval),
            txRef: a.txRef,
            providerTransactionId: a.paystack.providerTransactionId,
            eventType: "failed",
            status: "failed",
            amount: reportedOk ? a.paystack.amountKobo : a.order.amountKobo,
            currency: reportedOk ? a.paystack.currency : a.order.currency,
            rawResponse: { reason: "mismatch", field: a.field, source: a.source, paystack: a.paystack.evidence } as Prisma.InputJsonValue,
          },
          tx,
        );
      }
      await recordEvent(tx, a.event, "amount_mismatch");
    }, LOCK_TIMEOUTS);
  } catch (error) {
    console.error("fulfil: could not record a mismatch:", { txRef: a.txRef, error });
    // A webhook must be retried so the record is not lost; the page still tells the person the truth.
    if (a.event) return { outcome: "write_failed", order: a.order };
  }
  console.warn("fulfil: paid but does not match our order", { txRef: a.txRef, field: a.field });
  return { outcome: "mismatch", order: a.order, field: a.field };
}

type FulfilArgs = {
  userId: string;
  order: OrderSummary;
  interval: string;
  paystack: VerifiedTransaction;
  event: WebhookEventInput | undefined;
  source: FulfilSource;
  now: Date | undefined;
};

async function commitFulfilment(client: PrismaClient, a: FulfilArgs): Promise<FulfilResult> {
  const { txRef } = a.order;
  try {
    return await client.$transaction(async (tx): Promise<FulfilResult> => {
      await lockReference(tx, txRef);

      // Re-check inside the lock: the other caller may have finished while we were talking to Paystack.
      if ((await tx.paymentLog.count({ where: { txRef, eventType: "fulfilled" } })) > 0) {
        await recordEvent(tx, a.event, "already_fulfilled");
        return { outcome: "already_fulfilled", order: a.order };
      }

      const base = {
        userId: a.userId,
        provider: PROVIDER,
        planId: "pro",
        billingInterval: asInterval(a.interval),
        txRef,
        providerTransactionId: a.paystack.providerTransactionId,
        amount: a.paystack.amountKobo,
        currency: a.paystack.currency,
      } as const;
      // The evidence kept is the TRIMMED transaction: never card or customer details.
      await appendPaymentLog({ ...base, eventType: "verified", status: "successful", rawResponse: a.paystack.evidence }, tx);
      await appendPaymentLog({ ...base, eventType: "fulfilled", status: "successful", rawResponse: { source: a.source } }, tx);
      await activateSubscription(tx, { userId: a.userId, interval: asInterval(a.interval), txRef, now: a.now });

      if (a.event) {
        await tx.webhookEvent.upsert({
          where: {
            provider_eventType_providerTransactionId_providerStatus: {
              provider: PROVIDER,
              eventType: a.event.eventType,
              providerTransactionId: a.event.providerTransactionId,
              providerStatus: a.event.providerStatus,
            },
          },
          create: eventRow(a.event, "fulfilled"),
          update: { outcome: "fulfilled", processedAt: new Date() },
        });
      }
      return { outcome: "fulfilled", order: a.order };
    }, LOCK_TIMEOUTS);
  } catch (error) {
    // The database backstop: two fulfilments for one reference cannot both be inserted. Reaching this means the
    // lock and the re-check were bypassed; the loser's whole transaction was rolled back, so nothing is doubled.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const done = await client.paymentLog.count({ where: { txRef, eventType: "fulfilled" } });
      if (done > 0) {
        await recordEvent(client, a.event, "already_fulfilled");
        return { outcome: "already_fulfilled", order: a.order };
      }
    }
    // Any other failure: everything was rolled back (no verified row, no subscription). Retry later.
    console.error("fulfil: fulfilment failed and was rolled back:", { txRef, error });
    return { outcome: "write_failed", order: a.order };
  }
}

// Creates or extends the person's subscription, computing the dates in SQL from ONE reading of the clock.
//   - not currently active (no row, expired, canceled, past due): a new period starts now;
//   - already active with time left (a second payment, e.g. two browser tabs both paid): the new period is ADDED
//     to the current end, because they paid and must get the time. The period start is kept.
// One calendar month / one calendar year are added by Postgres, which clamps month ends (31 Jan + 1 month = 28 Feb).
async function activateSubscription(
  tx: Prisma.TransactionClient,
  a: { userId: string; interval: "monthly" | "yearly"; txRef: string; now: Date | undefined },
): Promise<void> {
  const length = a.interval === "yearly" ? Prisma.raw("interval '1 year'") : Prisma.raw("interval '1 month'");
  const nowExpr = a.now ? Prisma.sql`${a.now}::timestamptz` : Prisma.sql`clock_timestamp()`;
  await tx.$executeRaw(Prisma.sql`
    WITH n AS (SELECT ${nowExpr} AS t)
    INSERT INTO subscriptions
      (user_id, plan_id, billing_interval, status, current_period_start, current_period_end,
       cancel_at_period_end, cancellation_reason, last_tx_ref, created_at, updated_at)
    SELECT ${a.userId}::uuid, 'pro', ${a.interval}, 'active', n.t, n.t + ${length}, false, NULL, ${a.txRef}, n.t, n.t
    FROM n
    ON CONFLICT (user_id) DO UPDATE SET
      plan_id = 'pro',
      billing_interval = EXCLUDED.billing_interval,
      status = 'active',
      current_period_start = CASE
        WHEN subscriptions.status = 'active' AND subscriptions.current_period_end > EXCLUDED.current_period_start
        THEN subscriptions.current_period_start ELSE EXCLUDED.current_period_start END,
      current_period_end = CASE
        WHEN subscriptions.status = 'active' AND subscriptions.current_period_end > EXCLUDED.current_period_start
        THEN subscriptions.current_period_end + ${length} ELSE EXCLUDED.current_period_end END,
      cancel_at_period_end = false,
      cancellation_reason = NULL,
      last_tx_ref = EXCLUDED.last_tx_ref,
      updated_at = EXCLUDED.updated_at
  `);
}
