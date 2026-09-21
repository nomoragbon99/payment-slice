// For DISPLAY only. Money is stored and calculated as integer minor units (kobo); this is the one
// place an amount is turned into text for a person, by dividing by 100 at the very last step.
export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(amountMinor / 100);
}
