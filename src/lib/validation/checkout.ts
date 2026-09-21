import { z } from "zod";
import { checkoutConfig } from "@/config/checkout";
import { BILLING_INTERVALS } from "@/config/plans";

// A reference exactly as WE generate them: our prefix followed by a lowercase UUID. Anything else in
// the /checkout/return query string (someone's guess, a typo, a path-traversal attempt) is rejected
// before it is used to look anything up or is sent to Paystack.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const checkoutReferenceSchema = z
  .string()
  .regex(new RegExp(`^${checkoutConfig.txRefPrefix}${UUID}$`), "Not one of our payment references.");

// strictObject: any key other than billingInterval (for example a client-supplied `amount` or
// `planId`) is rejected with a 400 instead of being silently ignored. The price and the plan are
// decided by the server, so the client has no business sending them.
export const checkoutRequestSchema = z.strictObject({
  billingInterval: z.enum(BILLING_INTERVALS, { message: "billingInterval must be 'monthly' or 'yearly'." }),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
