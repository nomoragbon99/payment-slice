// Every tunable value for checkout initiation. Handlers import from here; no magic numbers elsewhere.

const MINUTE = 60;

export const checkoutConfig = {
  // Per signed-in user: at most `max` checkouts may be started in ANY `windowSeconds`-long stretch
  // (an exact sliding window). Every attempt that gets past the check counts, including ones that
  // later fail, so a failing Paystack cannot be hammered.
  rateLimit: { windowSeconds: 10 * MINUTE, max: 5 },

  // The /checkout/return page. Only a call to Paystack is rate limited; reading our own database is
  // not, and neither is a payment we already know is fulfilled. Per signed-in user.
  returnPage: {
    rateLimit: { windowSeconds: 10 * MINUTE, max: 12 },
    // While a payment is confirmed-but-not-yet-activated, the page re-checks by itself this often,
    // at most this many times, then tells the person to check again later. 6 x 5 s = 30 s.
    autoRefresh: { intervalMs: 5_000, maxRefreshes: 6 },
  },

  paystack: {
    baseUrl: "https://api.paystack.co",
    // Give up waiting for Paystack after this long. The customer is never given a payment URL in
    // that case, so a transaction Paystack may have created anyway can never be paid.
    timeoutMs: 10_000,
    // The payment page must be served from this domain (or a subdomain, e.g. checkout.paystack.com).
    authorizationDomain: "paystack.com",
  },

  // Where Paystack sends the customer after paying (appended to APP_URL). The page at this path only
  // ever VERIFIES the transaction with Paystack; it never grants anything from its query string.
  callbackPath: "/checkout/return",

  // Prefix of our own transaction references. Paystack accepts letters, digits and - . = only.
  txRefPrefix: "pslice-",
} as const;
