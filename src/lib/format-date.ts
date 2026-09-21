// For DISPLAY only. Dates are shown in UTC so the same date reads the same wherever the server or the
// browser happens to be (a period that ends at 23:30 UTC must not read as the next day on another machine).
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(date);
}
