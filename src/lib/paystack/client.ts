import { z } from "zod";
import { checkoutConfig } from "@/config/checkout";

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
