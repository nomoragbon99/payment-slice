import { z } from "zod";
import { checkoutConfig } from "@/config/checkout";
import { transactionEvidenceSchema, type TransactionEvidence } from "@/lib/paystack/evidence";

// Direct REST calls with fetch, no SDK (see DECISIONS.md: the official SDK's newest release is an
// empty package and it has no webhook helper). The secret key is only ever placed in the
// Authorization header: it is never logged, stored or returned.

export type InitializeInput = {
  email: string;
  amountKobo: number;
  currency: string;
  reference: string;
  callbackUrl: string;
};

// What went wrong, in a shape that is safe to store as jsonb evidence (no secrets in it).
export type InitializeFailure =
  | { ok: false; kind: "network_error"; message: string }
  | { ok: false; kind: "http_error"; httpStatus: number; body: unknown }
  | { ok: false; kind: "bad_response"; httpStatus: number; reason: string; body: unknown };

export type InitializeResult = { ok: true; authorizationUrl: string } | InitializeFailure;

const successBodySchema = z.object({
  status: z.literal(true),
  data: z.object({
    authorization_url: z.string(),
    reference: z.string(),
  }),
});

type Deps = { fetch?: typeof fetch };

// Paystack error bodies are small JSON; cap anything else so a huge or odd body cannot bloat the log.
function boundedBody(text: string): unknown {
  const capped = text.slice(0, 2000);
  try {
    return JSON.parse(capped);
  } catch {
    return { text: capped };
  }
}

function isPaystackHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const domain = checkoutConfig.paystack.authorizationDomain;
    return url.protocol === "https:" && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// GET /transaction/verify/{reference}
//
// Shape confirmed with real test-mode calls (the public spec omits most of it):
//   * A transaction that exists answers HTTP 200 { status: true, message: "Verification successful",
//     data: { id (number), status, reference, amount (integer kobo), currency, ... } } EVEN WHEN THE
//     CUSTOMER NEVER PAID (data.status is then "abandoned"). The outer `status: true` only means "the
//     API call worked"; whether the PAYMENT worked is data.status === "success", and nothing else.
//   * An unknown reference answers HTTP 400 (not 404) with { status: false, code:
//     "transaction_not_found", ... }. That machine code is what we match, not the English message.
// ---------------------------------------------------------------------------------------------

export type VerifiedTransaction = {
  // Paystack's own status: "success", "failed", "abandoned", "reversed" per the spec, possibly others.
  // Kept as the raw string; callers decide what an unrecognised value means.
  status: string;
  reference: string;
  amountKobo: number;
  currency: string;
  providerTransactionId: string;
  // The trimmed evidence to store with the payment: see evidence.ts. Contains no card or customer details.
  evidence: TransactionEvidence;
};

// Failures carry a reason but NEVER the response body. A body that failed our shape check could still be a
// full transaction with card details in it, and this app must not be able to store those by accident.
export type VerifyFailure =
  | { ok: false; kind: "network_error"; message: string }
  | { ok: false; kind: "not_found"; httpStatus: number }
  | { ok: false; kind: "http_error"; httpStatus: number }
  | { ok: false; kind: "bad_response"; httpStatus: number; reason: string };

export type VerifyResult = { ok: true; transaction: VerifiedTransaction } | VerifyFailure;

// data is parsed with the evidence schema, which keeps only the whitelisted fields and drops the rest.
const verifyBodySchema = z.object({
  status: z.literal(true),
  data: transactionEvidenceSchema,
});

const notFoundBodySchema = z.object({ code: z.literal("transaction_not_found") });

// Never throws: every outcome is a value the caller can act on. The reference is percent-encoded
// into the path (callers should already have validated its format).
export async function verifyTransaction(
  reference: string,
  secretKey: string,
  deps: Deps = {},
): Promise<VerifyResult> {
  const doFetch = deps.fetch ?? fetch;

  let response: Response;
  let text: string;
  try {
    response = await doFetch(`${checkoutConfig.paystack.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(checkoutConfig.paystack.timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return { ok: false, kind: "network_error", message: error instanceof Error ? error.message : String(error) };
  }

  const body = boundedBody(text);

  if (!response.ok) {
    if (response.status === 400 && notFoundBodySchema.safeParse(body).success) {
      return { ok: false, kind: "not_found", httpStatus: response.status };
    }
    return { ok: false, kind: "http_error", httpStatus: response.status };
  }

  const parsed = verifyBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, kind: "bad_response", httpStatus: response.status, reason: "unexpected response shape" };
  }

  const { data } = parsed.data;
  return {
    ok: true,
    transaction: {
      status: data.status,
      reference: data.reference,
      amountKobo: data.amount,
      currency: data.currency,
      providerTransactionId: String(data.id),
      evidence: data,
    },
  };
}

// POST /transaction/initialize. Never throws: every outcome is a value the caller can log.
export async function initializeTransaction(
  input: InitializeInput,
  secretKey: string,
  deps: Deps = {},
): Promise<InitializeResult> {
  const doFetch = deps.fetch ?? fetch;

  let response: Response;
  let text: string;
  try {
    response = await doFetch(`${checkoutConfig.paystack.baseUrl}/transaction/initialize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        amount: input.amountKobo, // integer kobo, as Paystack expects
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
      }),
      signal: AbortSignal.timeout(checkoutConfig.paystack.timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    // DNS failure, connection reset, timeout (AbortError/TimeoutError), body read failure.
    return { ok: false, kind: "network_error", message: error instanceof Error ? error.message : String(error) };
  }

  const body = boundedBody(text);

  if (!response.ok) {
    return { ok: false, kind: "http_error", httpStatus: response.status, body };
  }

  const parsed = successBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, kind: "bad_response", httpStatus: response.status, reason: "unexpected response shape", body };
  }
  if (parsed.data.data.reference !== input.reference) {
    return { ok: false, kind: "bad_response", httpStatus: response.status, reason: "reference does not match ours", body };
  }
  if (!isPaystackHttpsUrl(parsed.data.data.authorization_url)) {
    return {
      ok: false,
      kind: "bad_response",
      httpStatus: response.status,
      reason: "authorization_url is not an https Paystack URL",
      body,
    };
  }

  return { ok: true, authorizationUrl: parsed.data.data.authorization_url };
}
