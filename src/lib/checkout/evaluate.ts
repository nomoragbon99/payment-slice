import type { VerifiedTransaction } from "@/lib/paystack/client";

// THE rule for "does what Paystack says match the order we recorded, and is it paid?". One pure function
// (no database, no network) used by BOTH the return page and fulfilment, so the two can never disagree about
// what counts as a payment worth honouring.

// What we recorded on the 'initiated' row before the customer could reach Paystack.
export type OrderTerms = { txRef: string; amountKobo: number; currency: string };

export type Evaluation =
  // Paid, and exactly the order we recorded: safe to fulfil.
  | { kind: "fulfil" }
  // Paystack answered about the wrong reference, or the paid amount or currency is not what we recorded.
  | { kind: "mismatch"; field: "reference" | "amount" | "currency" }
  // Not (yet) paid. `paystackStatus` is the recognised meaning; `rawStatus` is exactly what Paystack said.
  // failed, abandoned and other non-final statuses are NOT final: a declined card can be retried on the same
  // reference, and a checkout left open can be paid hours later (both seen with real test payments).
  | { kind: "not_paid"; paystackStatus: "failed" | "abandoned" | "reversed" | "other"; rawStatus: string };

export function evaluateTransaction(
  order: OrderTerms,
  tx: Pick<VerifiedTransaction, "status" | "reference" | "amountKobo" | "currency">,
): Evaluation {
  // An answer about some other transaction than the one we asked about cannot be trusted at all.
  if (tx.reference !== order.txRef) return { kind: "mismatch", field: "reference" };

  switch (tx.status) {
    case "success":
      // Only "success" is a payment. It must be exactly the order we recorded.
      if (tx.amountKobo !== order.amountKobo) return { kind: "mismatch", field: "amount" };
      if (tx.currency !== order.currency) return { kind: "mismatch", field: "currency" };
      return { kind: "fulfil" };
    case "failed":
      return { kind: "not_paid", paystackStatus: "failed", rawStatus: tx.status };
    case "abandoned":
      return { kind: "not_paid", paystackStatus: "abandoned", rawStatus: tx.status };
    case "reversed":
      return { kind: "not_paid", paystackStatus: "reversed", rawStatus: tx.status };
    default:
      // Any status we do not recognise is treated as "not final yet", never as paid.
      return { kind: "not_paid", paystackStatus: "other", rawStatus: tx.status };
  }
}
