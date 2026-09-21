import { checkoutConfig } from "@/config/checkout";
import type { PrismaClient } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { fulfilTransaction, type FulfilResult } from "@/lib/checkout/fulfil";
import { orderFromInitiatedRow, type OrderSummary } from "@/lib/checkout/order";
import { consume as realConsume, type ConsumeResult } from "@/lib/security/rate-limit";
import { checkoutReferenceSchema } from "@/lib/validation/checkout";

// What the /checkout/return page shows.
//
// THIS PAGE DECIDES NOTHING. Arriving here from a redirect proves nothing: the reference in the URL only
// NAMES a payment. It hands that reference to fulfilTransaction(), the one function shared with the webhook,
// which asks Paystack itself (server to server, with our secret key), checks the answer against the order we
// recorded before the customer could pay, and only then activates the subscription. The page then reports
// what that function found. Whichever of the webhook and this page arrives first does the work; the other
// finds it done and changes nothing (see fulfil.ts).

export type { OrderSummary };

export type ReturnState =
  // Verified and activated (now, or earlier by the webhook): our ledger records the fulfilment.
  | { kind: "successful"; order: OrderSummary }
  // Paystack confirmed the payment but our own write failed and was rolled back: it is safe to check again.
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
  db?: PrismaClient;
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
  //    does not exist, so nobody can probe for, or trigger, other people's payments.
  const rows = await client.paymentLog.findMany({ where: { txRef, userId: input.userId }, orderBy: { createdAt: "asc" } });
  const initiated = rows.find((row) => row.eventType === "initiated");
  if (!initiated) return { kind: "unknown" };

  // What we show about the order always comes from OUR record, never from Paystack's response.
  const order = orderFromInitiatedRow(initiated);

  // 3. Already fulfilled: our ledger records an earlier independent verification. No Paystack call, no rate limit used.
  if (rows.some((row) => row.eventType === "fulfilled")) return { kind: "successful", order };

  // 4. Not yet fulfilled: we will have to ask Paystack, so only if we are able to (key set) and allowed to (rate limit).
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

  // 5. The shared function verifies with Paystack and, only if the payment is real and matches, activates it.
  const result = await fulfilTransaction(
    { reference: txRef, source: "return_page", expectedUserId: input.userId, secretKey: input.secretKey },
    { db: client, fetch: deps.fetch },
  );

  return stateFromFulfilment(result, order);
}

// Turns what fulfilTransaction found into what the page shows.
function stateFromFulfilment(result: FulfilResult, order: OrderSummary): ReturnState {
  switch (result.outcome) {
    case "fulfilled":
    case "already_fulfilled":
      return { kind: "successful", order };
    case "write_failed":
      // Paid according to Paystack, but our write did not go through (and left nothing behind): checking again retries it.
      return { kind: "activating", order };
    case "mismatch":
      return { kind: "mismatch", order };
    case "not_paid":
      return notPaidState(result, order);
    case "unknown":
      // Paystack has never heard of a reference we DO have: our own initiation call never reached it.
      return { kind: "unknown" };
    case "cannot_verify":
    case "duplicate_event":
      // (duplicate_event only exists for webhooks; the page never produces it.)
      return { kind: "cannot_check", reason: "unavailable", order };
  }
}

function notPaidState(result: Extract<FulfilResult, { outcome: "not_paid" }>, order: OrderSummary): ReturnState {
  switch (result.paystackStatus) {
    case "failed":
      return { kind: "failed", order };
    case "abandoned":
      return { kind: "not_completed", order };
    case "reversed":
      return { kind: "reversed", order };
    case "other":
      console.warn("/checkout/return: unrecognised Paystack status", { txRef: order.txRef, status: result.rawStatus });
      return { kind: "processing", order };
  }
}
