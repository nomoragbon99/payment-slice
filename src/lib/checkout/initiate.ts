import { randomUUID } from "crypto";
import { checkoutConfig } from "@/config/checkout";
import { PLAN, getAmountKobo, type BillingInterval } from "@/config/plans";
import { db } from "@/lib/db";
import { appendPaymentLog, type PaymentLogEntry } from "@/lib/payment-log";
import { initializeTransaction, type InitializeFailure } from "@/lib/paystack/client";
import type { Prisma } from "@/generated/prisma/client";

export type InitiateCheckoutInput = {
  userId: string;
  email: string;
  billingInterval: BillingInterval;
  // Read from the environment by the caller so this function stays testable; undefined = not set.
  appUrl: string | undefined;
  secretKey: string | undefined;
};

export type InitiateCheckoutResult =
  | { ok: true; authorizationUrl: string; txRef: string }
  | { ok: false; code: "ALREADY_SUBSCRIBED" | "NOT_CONFIGURED" }
  | { ok: false; code: "PROVIDER_FAILED"; txRef: string };

// `fetch` and `db` can be replaced so the failure paths can be tested without a real Paystack
// outage, and inside a transaction that rolls back (payment_log rows can never be deleted).
type Deps = {
  fetch?: typeof fetch;
  db?: Pick<Prisma.TransactionClient, "subscription" | "paymentLog">;
};

// Starts a purchase. Order matters:
//   1. refuse users who already have an active subscription (no accidental double payment);
//   2. check configuration BEFORE writing anything, so a misconfigured server leaves no rows;
//   3. write the 'initiated' log row BEFORE calling Paystack, so the amount we expect is on record
//      before the customer can ever reach Paystack (a later webhook or return visit needs it);
//   4. call Paystack; on any failure APPEND a 'failed' row. The 'initiated' row is never touched:
//      payment_log is append-only.
export async function initiateCheckout(
  input: InitiateCheckoutInput,
  deps: Deps = {},
): Promise<InitiateCheckoutResult> {
  const client = deps.db ?? db;

  const existing = await client.subscription.findUnique({ where: { userId: input.userId } });
  if (existing && existing.status === "active" && existing.currentPeriodEnd > new Date()) {
    return { ok: false, code: "ALREADY_SUBSCRIBED" };
  }

  if (!input.secretKey || !input.appUrl) {
    return { ok: false, code: "NOT_CONFIGURED" };
  }

  const txRef = `${checkoutConfig.txRefPrefix}${randomUUID()}`;
  const amountKobo = getAmountKobo(input.billingInterval);
  const callbackUrl = `${new URL(input.appUrl).origin}${checkoutConfig.callbackPath}`;

  // The request we are about to send, kept as evidence on the 'initiated' row. It holds no secrets.
  const outgoingRequest = {
    email: input.email,
    amount: amountKobo,
    currency: PLAN.currency,
    reference: txRef,
    callback_url: callbackUrl,
  };

  const base: LogBase = {
    userId: input.userId,
    provider: "paystack",
    planId: PLAN.id,
    billingInterval: input.billingInterval,
    txRef,
    amount: amountKobo,
    currency: PLAN.currency,
  };

  // If this write fails the error propagates (the route answers 500) and Paystack is never called.
  await appendPaymentLog({ ...base, eventType: "initiated", status: "pending", rawResponse: outgoingRequest }, client);

  const result = await initializeTransaction(
    {
      email: input.email,
      amountKobo,
      currency: PLAN.currency,
      reference: txRef,
      callbackUrl,
    },
    input.secretKey,
    { fetch: deps.fetch },
  );

  if (result.ok) {
    return { ok: true, authorizationUrl: result.authorizationUrl, txRef };
  }

  await recordFailure(base, result, client);
  return { ok: false, code: "PROVIDER_FAILED", txRef };
}

type LogBase = Omit<PaymentLogEntry, "eventType" | "status" | "rawResponse" | "providerTransactionId">;

async function recordFailure(
  base: LogBase,
  failure: InitializeFailure,
  client: Pick<Prisma.TransactionClient, "paymentLog">,
): Promise<void> {
  // The response body is not printed to the server console: it is stored (size-capped) in the failed row.
  console.error("checkout: Paystack initialize failed", {
    txRef: base.txRef,
    kind: failure.kind,
    httpStatus: "httpStatus" in failure ? failure.httpStatus : undefined,
  });

  // The failure value minus its discriminator flag: this is the evidence stored as jsonb.
  const evidence: Record<string, unknown> = { ...failure };
  delete evidence.ok;

  try {
    await appendPaymentLog(
      { ...base, eventType: "failed", status: "failed", rawResponse: evidence as Prisma.InputJsonValue },
      client,
    );
  } catch (error) {
    // The customer still gets the 502; the 'initiated' row simply has no follow-up, which is how a
    // crashed or half-logged attempt looks and is easy to find with a query.
    console.error("checkout: could not record the failed attempt", { txRef: base.txRef, error });
  }
}
