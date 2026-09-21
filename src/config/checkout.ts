// Every tunable value for checkout initiation. Handlers import from here; no magic numbers elsewhere.

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const checkoutConfig = {
  // Per signed-in user: how many times they may start a checkout in one window. Every attempt
  // counts, including ones that later fail, so a failing Paystack cannot be hammered.
  rateLimit: { windowSeconds: 10 * MINUTE, max: 5 },

  rateLimitCleanup: {
    // How often (at most) the opportunistic sweep of old rate_limit_buckets rows runs, per process.
    intervalSeconds: 5 * MINUTE,
    // How long a bucket row is kept before that sweep deletes it.
    bucketRetentionSeconds: 24 * HOUR,
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
