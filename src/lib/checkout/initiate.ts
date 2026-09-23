import { randomUUID } from "crypto";
import { checkoutConfig } from "@/config/checkout";
import { PLAN, getAmountKobo, type BillingInterval } from "@/config/plans";
import { db } from "@/lib/db";
import { quoteUpgrade, type ProrationQuote } from "@/lib/billing/proration";
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

  return startPaystackCheckout(
    { userId: input.userId, email: input.email, billingInterval: input.billingInterval, amountKobo: getAmountKobo(input.billingInterval), appUrl: input.appUrl, secretKey: input.secretKey },
    { fetch: deps.fetch, db: client },
  );
}

export type InitiateUpgradeInput = {
  userId: string;
  email: string;
  appUrl: string | undefined;
  secretKey: string | undefined;
};

export type InitiateUpgradeResult =
  | { ok: true; authorizationUrl: string; txRef: string; quote: ProrationQuote }
  | { ok: false; code: "NOT_ELIGIBLE"; reason: "not_subscribed" | "already_yearly" | "cancelled" | "lapsed" }
  | { ok: false; code: "NOT_CONFIGURED" }
  | { ok: false; code: "PROVIDER_FAILED"; txRef: string };

type UpgradeDeps = {
  fetch?: typeof fetch;
  db?: Pick<Prisma.TransactionClient, "subscription" | "paymentLog">;
  now?: Date;
};

// Starts a Pro monthly -> Pro yearly upgrade for the amount quoteUpgrade computes, NOT the full yearly
// price. Reuses the same tail as initiateCheckout (write 'initiated' row, then call Paystack): from
// Paystack's own initialize call onward, and everywhere downstream (verify, fulfil, webhook, return
// page), this is indistinguishable from any other yearly purchase. Only the amount differs, and it is
// computed here, server-side, exactly the same way it was shown on the billing page.
export async function initiateUpgrade(input: InitiateUpgradeInput, deps: UpgradeDeps = {}): Promise<InitiateUpgradeResult> {
  const client = deps.db ?? db;
  const now = deps.now ?? new Date();

  const row = await client.subscription.findUnique({
    where: { userId: input.userId },
    select: { billingInterval: true, status: true, currentPeriodStart: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
  });
  const eligibility = quoteUpgrade(row, now);
  if (!eligibility.eligible) return { ok: false, code: "NOT_ELIGIBLE", reason: eligibility.reason };

  if (!input.secretKey || !input.appUrl) {
    return { ok: false, code: "NOT_CONFIGURED" };
  }

  const result = await startPaystackCheckout(
    { userId: input.userId, email: input.email, billingInterval: "yearly", amountKobo: eligibility.quote.chargeKobo, appUrl: input.appUrl, secretKey: input.secretKey },
    { fetch: deps.fetch, db: client },
  );
  if (!result.ok) return result;
  return { ...result, quote: eligibility.quote };
}

// ---------------------------------------------------------------------------------------------------------

type StartCheckoutInput = {
  userId: string;
  email: string;
  billingInterval: BillingInterval;
  amountKobo: number;
  appUrl: string;
  secretKey: string;
};

type StartCheckoutResult = { ok: true; authorizationUrl: string; txRef: string } | { ok: false; code: "PROVIDER_FAILED"; txRef: string };

// The part initiateCheckout and initiateUpgrade share: write the 'initiated' row (append-only, before
// Paystack is ever called), call Paystack, and append a 'failed' row on any provider failure. Neither
// caller's own eligibility/amount decision lives here -- this only ever executes an already-decided order.
async function startPaystackCheckout(
  input: StartCheckoutInput,
  deps: { fetch?: typeof fetch; db: Pick<Prisma.TransactionClient, "paymentLog"> },
): Promise<StartCheckoutResult> {
  const txRef = `${checkoutConfig.txRefPrefix}${randomUUID()}`;
  const callbackUrl = `${new URL(input.appUrl).origin}${checkoutConfig.callbackPath}`;

  // The request we are about to send, kept as evidence on the 'initiated' row. It holds no secrets.
  const outgoingRequest = {
    email: input.email,
    amount: input.amountKobo,
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
    amount: input.amountKobo,
    currency: PLAN.currency,
  };

  // If this write fails the error propagates (the route answers 500) and Paystack is never called.
  await appendPaymentLog({ ...base, eventType: "initiated", status: "pending", rawResponse: outgoingRequest }, deps.db);

  const result = await initializeTransaction(
    {
      email: input.email,
      amountKobo: input.amountKobo,
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

  await recordFailure(base, result, deps.db);
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
