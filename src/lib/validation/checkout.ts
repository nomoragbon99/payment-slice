import { z } from "zod";
import { BILLING_INTERVALS } from "@/config/plans";

// strictObject: any key other than billingInterval (for example a client-supplied `amount` or
// `planId`) is rejected with a 400 instead of being silently ignored. The price and the plan are
// decided by the server, so the client has no business sending them.
export const checkoutRequestSchema = z.strictObject({
  billingInterval: z.enum(BILLING_INTERVALS, { message: "billingInterval must be 'monthly' or 'yearly'." }),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
