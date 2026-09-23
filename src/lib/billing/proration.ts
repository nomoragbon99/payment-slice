import { PLAN, getAmountKobo } from "@/config/plans";

// The prorated cost of switching from Pro monthly to Pro yearly, mid-cycle, and whether someone is
// even allowed to do that right now. Both halves are ONE function so /billing and the upgrade route
// can never compute (or disagree about) the price differently, same reasoning as describeSubscription().
//
// Formula (see DECISIONS.md for the worked example): the unused portion of the CURRENT period is
// converted into a credit against the yearly price. "Unused" is measured against the period's own
// real length (current_period_end - current_period_start), never an assumed 30 days, because a
// monthly period is not always 30 days (Postgres clamps month-end arithmetic).
//
//   unused_fraction = (current_period_end - now) / (current_period_end - current_period_start)
//   credit_kobo     = round(unused_fraction * monthly_price_kobo)
//   charge_kobo     = yearly_price_kobo - credit_kobo

export type UpgradeEligibleRow = {
  billingInterval: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
};

export type ProrationQuote = { chargeKobo: number; creditKobo: number; currency: string };

export type UpgradeEligibility =
  | { eligible: true; quote: ProrationQuote }
  | { eligible: false; reason: "not_subscribed" | "already_yearly" | "cancelled" | "lapsed" };

// `now` is a parameter (never `new Date()` inside) so a quote shown on a page and a quote charged
// moments later at checkout are each computed fresh from the same rule, and tests can pin exact days.
export function quoteUpgrade(row: UpgradeEligibleRow | null, now: Date): UpgradeEligibility {
  if (!row || row.status !== "active" || row.currentPeriodEnd.getTime() <= now.getTime()) {
    return { eligible: false, reason: row && row.status === "active" ? "lapsed" : "not_subscribed" };
  }
  if (row.billingInterval === "yearly") return { eligible: false, reason: "already_yearly" };
  // Must "Keep my plan" (resume) first: upgrading and un-cancelling in the same action is hard to
  // reason about, and cancelSubscription/resumeSubscription already own that decision.
  if (row.cancelAtPeriodEnd) return { eligible: false, reason: "cancelled" };

  const periodLengthMs = row.currentPeriodEnd.getTime() - row.currentPeriodStart.getTime();
  const remainingMs = row.currentPeriodEnd.getTime() - now.getTime();
  const unusedFraction = periodLengthMs > 0 ? remainingMs / periodLengthMs : 0;

  const monthlyPriceKobo = getAmountKobo("monthly");
  const yearlyPriceKobo = getAmountKobo("yearly");
  const creditKobo = Math.round(unusedFraction * monthlyPriceKobo);
  // The credit can never approach the yearly price (it is capped at one month's price, a tenth of the
  // yearly price), but the floor is kept explicit rather than assumed, since payment_log.amount has a
  // CHECK amount > 0 that a silent zero or negative charge would violate.
  const chargeKobo = Math.max(1, yearlyPriceKobo - creditKobo);

  return { eligible: true, quote: { chargeKobo, creditKobo, currency: PLAN.currency } };
}
