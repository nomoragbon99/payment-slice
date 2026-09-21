// What the "Choose this plan" button does with the answer from POST /api/checkout. Kept as a pure function so it can
// be tested without a browser. The one thing that is ever done with a URL is sending the browser to it, so the URL is
// checked again here even though the server already validated it: it must be https on paystack.com (or a subdomain).

export type CheckoutOutcome =
  | { action: "redirect"; url: string }
  | { action: "sign_in" }
  | { action: "message"; text: string };

const GENERIC = "Something went wrong. Please try again.";

function isPaystackHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paystack.com" || url.hostname.endsWith(".paystack.com"));
  } catch {
    return false;
  }
}

function waitText(retryAfter: string | null): string {
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return "a little while";
  return seconds < 90 ? `${Math.ceil(seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}

export function interpretCheckoutResponse(status: number, body: unknown, retryAfter: string | null = null): CheckoutOutcome {
  const url = body && typeof body === "object" ? (body as { authorizationUrl?: unknown }).authorizationUrl : undefined;

  if (status === 200) {
    return isPaystackHttpsUrl(url) ? { action: "redirect", url } : { action: "message", text: GENERIC };
  }
  switch (status) {
    case 401:
      return { action: "sign_in" };
    case 409:
      return { action: "message", text: "You already have an active plan." };
    case 429:
      return { action: "message", text: `Too many attempts. Please try again in ${waitText(retryAfter)}.` };
    case 502:
    case 503:
      return { action: "message", text: "We couldn't start the payment. Please try again shortly." };
    default:
      return { action: "message", text: GENERIC };
  }
}
