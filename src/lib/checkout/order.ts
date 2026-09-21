import { PLAN } from "@/config/plans";

// What we tell a person about an order. It always comes from OUR 'initiated' row, never from Paystack's reply.
export type OrderSummary = {
  txRef: string;
  planName: string;
  billingInterval: string;
  amountKobo: number;
  currency: string;
};

type InitiatedRow = { txRef: string; planId: string; billingInterval: string; amount: number; currency: string };

export function orderFromInitiatedRow(row: InitiatedRow): OrderSummary {
  return {
    txRef: row.txRef,
    planName: row.planId === PLAN.id ? PLAN.name : row.planId,
    billingInterval: row.billingInterval,
    amountKobo: row.amount,
    currency: row.currency,
  };
}
