import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

// The ONLY way application code writes to payment_log, and it only ever INSERTS. payment_log is
// append-only: corrections are new rows, never edits. A database trigger rejects UPDATE, DELETE
// and TRUNCATE (see the init migration), but Prisma Client still generates update/delete for this
// model, so no other code may call them. `db.paymentLog` should appear only in this file (plus reads).
export type PaymentLogEntry = {
  userId: string;
  provider: "paystack";
  planId: "pro";
  billingInterval: "monthly" | "yearly";
  txRef: string;
  providerTransactionId?: string | null;
  eventType: "initiated" | "verified" | "fulfilled" | "failed";
  status: "pending" | "successful" | "failed";
  amount: number;
  currency: string;
  rawResponse?: Prisma.InputJsonValue;
};

// `client` defaults to the shared client; a caller already inside db.$transaction(...) passes its
// transaction client so the log row commits or rolls back together with the caller's other writes.
export async function appendPaymentLog(
  entry: PaymentLogEntry,
  client: Pick<Prisma.TransactionClient, "paymentLog"> = db,
): Promise<void> {
  await client.paymentLog.create({
    data: {
      userId: entry.userId,
      provider: entry.provider,
      planId: entry.planId,
      billingInterval: entry.billingInterval,
      txRef: entry.txRef,
      providerTransactionId: entry.providerTransactionId ?? null,
      eventType: entry.eventType,
      status: entry.status,
      amount: entry.amount,
      currency: entry.currency,
      rawResponse: entry.rawResponse,
    },
  });
}
