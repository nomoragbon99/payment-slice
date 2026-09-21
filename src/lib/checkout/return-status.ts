import { checkoutConfig } from "@/config/checkout";
import { PLAN } from "@/config/plans";
import { db } from "@/lib/db";
import { verifyTransaction, type VerifiedTransaction } from "@/lib/paystack/client";
import { evaluateTransaction } from "@/lib/checkout/evaluate";
import { consume as realConsume, type ConsumeResult } from "@/lib/security/rate-limit";
import { checkoutReferenceSchema } from "@/lib/validation/checkout";
import type { Prisma } from "@/generated/prisma/client";

// What the /checkout/return page shows. This module is READ-ONLY with respect to payments: it never
// writes to payment_log or subscriptions and never grants anything. Whether a payment activates a
// subscription is decided elsewhere (the fulfilment step), from Paystack's verified data; arriving
// here from a redirect proves nothing and changes nothing.

export type OrderSummary = {
  txRef: string;
  planName: string;
  billingInterval: string;
  amountKobo: number;
  currency: string;
};

export type ReturnState =
  // Our own ledger has a 'fulfilled' row: verified earlier, subscription activated.
  | { kind: "successful"; order: OrderSummary }
  // Paystack says paid and it matches our order, but the ledger has no 'fulfilled' row yet.
  | { kind: "activating"; order: OrderSummary }
  // Paystack reports a status we do not recognise (treated as "not final yet").
  | { kind: "processing"; order: OrderSummary }
  | { kind: "not_completed"; order: OrderSummary } // Paystack: abandoned
  | { kind: "failed"; order: OrderSummary } // Paystack: failed
  | { kind: "reversed"; order: OrderSummary } // Paystack: reversed
  // Paystack says paid but reference, amount or currency differ from what we recorded.
  | { kind: "mismatch"; order: OrderSummary }
  // We could not find out: Paystack unreachable or answered nonsense, or our rate limit was hit.
  | { kind: "cannot_check"; reason: "unavailable" | "rate_limited"; retryAfterSeconds?: number; order: OrderSummary }
  // No such payment for this person (missing, malformed, not ours, someone else's, or never started).
  | { kind: "unknown" };

type RateLimit = { windowSeconds: number; max: number };

type Deps = {
  db?: Pick<Prisma.TransactionClient, "paymentLog">;
  fetch?: typeof fetch;
  consume?: (key: string, limit: RateLimit) => Promise<ConsumeResult>;
};

// Paystack appends BOTH ?reference= and ?trxref= (same value). Next.js gives a string, or an array
// when a parameter is repeated; a repeated parameter is treated as no reference at all.
export function pickReference(params: { reference?: string | string[]; trxref?: string | string[] }): string | undefined {
  if (Array.isArray(params.reference) || Array.isArray(params.trxref)) return undefined;
  return params.reference ?? params.trxref;
}

export async function getReturnStatus(
  input: { userId: string; reference: string | undefined; secretKey: string | undefined },
  deps: Deps = {},
): Promise<ReturnState> {
  const client = deps.db ?? db;
  const consume = deps.consume ?? realConsume;

  // 1. The reference is untrusted input: it must look exactly like one of ours.
  const parsedReference = checkoutReferenceSchema.safeParse(input.reference);
  if (!parsedReference.success) return { kind: "unknown" };
  const txRef = parsedReference.data;

  // 2. Only THIS user's own rows count. Another person's reference is indistinguishable from one that
  //    does not exist, so nobody can probe for other people's payments.
  const rows = await client.paymentLog.findMany({ where: { txRef, userId: input.userId }, orderBy: { createdAt: "asc" } });
  const initiated = rows.find((row) => row.eventType === "initiated");
  if (!initiated) return { kind: "unknown" };

  // What we show about the order always comes from OUR record, never from Paystack's response.
  const order: OrderSummary = {
    txRef,
    planName: initiated.planId === PLAN.id ? PLAN.name : initiated.planId,
    billingInterval: initiated.billingInterval,
    amountKobo: initiated.amount,
    currency: initiated.currency,
  };

  // 3. Already fulfilled: our ledger is the record of an earlier independent verification. No Paystack call.
  if (rows.some((row) => row.eventType === "fulfilled")) return { kind: "successful", order };

  // 4. Not yet fulfilled: ask Paystack, but only if we are allowed to (rate limit) and able to (key set).
  if (!input.secretKey) {
    console.error("/checkout/return: PAYSTACK_SECRET_KEY is not set; cannot verify payments.");
    return { kind: "cannot_check", reason: "unavailable", order };
  }

  try {
    const limit = await consume(`checkout-return:user:${input.userId}`, checkoutConfig.returnPage.rateLimit);
    if (!limit.allowed) {
      return { kind: "cannot_check", reason: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds, order };
    }
  } catch (error) {
    // The limiter failed closed: do not call Paystack, and say honestly that we could not check.
    console.error("/checkout/return: rate limiter error:", error);
    return { kind: "cannot_check", reason: "unavailable", order };
  }

  const result = await verifyTransaction(txRef, input.secretKey, { fetch: deps.fetch });

  if (!result.ok) {
    // Paystack has never heard of a reference we DO have: our own initiation call never reached it.
    if (result.kind === "not_found") return { kind: "unknown" };
    console.error("/checkout/return: could not verify with Paystack:", { txRef, kind: result.kind });
    return { kind: "cannot_check", reason: "unavailable", order };
  }

  return stateFromPaystack(result.transaction, order);
}

// Turns the shared evaluation (evaluate.ts) into what the page shows. The rules themselves live in one place.
function stateFromPaystack(t: VerifiedTransaction, order: OrderSummary): ReturnState {
  const evaluation = evaluateTransaction(order, t);

  switch (evaluation.kind) {
    case "mismatch":
      console.warn(
        evaluation.field === "reference"
          ? "/checkout/return: Paystack answered for a different reference"
          : "/checkout/return: paid amount or currency differs from our record",
        { txRef: order.txRef },
      );
      return { kind: "mismatch", order };
    case "fulfil":
      // Confirmed by Paystack, but no 'fulfilled' row yet: the fulfilment step has not run (or not finished).
      return { kind: "activating", order };
    case "not_paid":
      switch (evaluation.paystackStatus) {
        case "failed":
          return { kind: "failed", order };
        case "abandoned":
          return { kind: "not_completed", order };
        case "reversed":
          return { kind: "reversed", order };
        case "other":
          console.warn("/checkout/return: unrecognised Paystack status", { txRef: order.txRef, status: evaluation.rawStatus });
          return { kind: "processing", order };
      }
  }
}
