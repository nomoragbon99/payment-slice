import { z } from "zod";

// The ONLY fields of a Paystack transaction that this app ever keeps. It is the evidence stored with a
// payment (payment_log.raw_response) and with a webhook (webhook_events.payload): enough to answer a
// dispute (which transaction, how much, in what currency, when, over which channel, what the bank said),
// and nothing more.
//
// Why so little: Paystack's real payloads also carry the customer's email and phone and a whole
// `authorization` object (card bin, last4, expiry, bank, a card signature and an `authorization_code` marked
// `reusable: true`, which can be used to charge that card again later). The brief forbids storing card
// details, so none of that may reach our database. This is enforced by construction: a zod object STRIPS
// every key that is not listed here, so a new sensitive field Paystack adds later is dropped automatically,
// without anyone having to remember to remove it.
export const transactionEvidenceSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  reference: z.string(),
  amount: z.number().int(), // integer minor units (kobo)
  currency: z.string(),
  paid_at: z.string().nullish(),
  channel: z.string().nullish(),
  gateway_response: z.string().nullish(),
  domain: z.string().nullish(),
});

export type TransactionEvidence = z.infer<typeof transactionEvidenceSchema>;
