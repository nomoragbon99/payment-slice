// The one paid plan and its prices. The server is the only place a price comes from: the client
// sends a billing interval and never an amount, so nobody can pay less by editing a request.
//
// Money rules: every amount is an INTEGER in minor units (kobo; 100 kobo = 1 naira) and sits next
// to its currency. An amount without a currency is invalid.
//
// "No subscription row" means the free plan (see DECISIONS.md), so only paid plans appear here.

export const BILLING_INTERVALS = ["monthly", "yearly"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const PLAN = {
  id: "pro",
  name: "Pro",
  currency: "NGN",
  prices: {
    monthly: { amountKobo: 300_000 }, // NGN 3,000
    yearly: { amountKobo: 3_000_000 }, // NGN 30,000
  } satisfies Record<BillingInterval, { amountKobo: number }>,
} as const;

export function getAmountKobo(interval: BillingInterval): number {
  return PLAN.prices[interval].amountKobo;
}
