import type { PrismaClient } from "@/generated/prisma/client";
import { fulfilTransaction, type FulfilResult } from "@/lib/checkout/fulfil";
import { isValidWebhookSignature, MAX_WEBHOOK_BYTES, parseWebhookBody } from "@/lib/paystack/webhook";

// The logic behind POST /api/webhooks/paystack, kept apart from the route file so it can be tested with a
// fake Paystack and a temporary database. It answers only with a status code and a tiny generic body: nothing
// about why is ever said to the caller.
//
//   413  body too large                                        (nothing read beyond the limit)
//   500  our own secret key is not configured                  (Paystack retries)
//   401  missing or wrong signature                            (no parsing, no database, no Paystack call)
//   400  signed but not a body we can act on                   (retrying the same bytes cannot help)
//   200  event type we do not handle (acknowledged, not stored)
//   200  handled: fulfilled, already fulfilled, a duplicate delivery, paid-but-mismatched, not actually paid
//        according to Paystack's own verify call, or a reference that is not ours (each recorded once)
//   503  could not finish (Paystack unreachable or erroring, our write failed and was rolled back, or anything
//        unexpected): nothing half-done is left, and Paystack's retry is safe because everything is idempotent

type Deps = {
  secretKey: string | undefined;
  db?: PrismaClient;
  fetch?: typeof fetch;
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const RETRY_LATER = () => new Response(JSON.stringify({ received: false }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "60" } });

// Reads at most `max` bytes, so a huge body never gets buffered in full.
async function readBodyLimited(request: Request, max: number): Promise<Buffer | "too_large"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return "too_large";
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function handlePaystackWebhook(request: Request, deps: Deps): Promise<Response> {
  // The arrival time: stamped BEFORE anything else (before the body is read, before the signature is checked, before
  // any Paystack call), so it reflects when the request reached us, not when we finished. It is stored as
  // webhook_events.received_at; the row is only written after processing, so this is the only place it survives.
  const receivedAt = new Date();

  try {
    // 1. Size first: cheap, and nothing is computed over an oversized body.
    const raw = await readBodyLimited(request, MAX_WEBHOOK_BYTES);
    if (raw === "too_large") return json(413, { received: false });

    // 2. Authenticate BEFORE parsing anything. Without our key nothing can be trusted, so say we cannot serve.
    if (!deps.secretKey) {
      console.error("webhook: PAYSTACK_SECRET_KEY is not set; cannot verify signatures.");
      return json(500, { received: false });
    }
    if (!isValidWebhookSignature(raw, request.headers.get("x-paystack-signature"), deps.secretKey)) {
      console.warn("webhook: rejected a request with a missing or invalid signature");
      return json(401, { received: false });
    }

    // 3. Parse (signature already verified), then handle only charge.success.
    const parsed = parseWebhookBody(raw);
    if (parsed.kind === "malformed") {
      console.warn("webhook: signed but malformed body");
      return json(400, { received: false });
    }
    if (parsed.kind === "ignored") return json(200, { received: true });

    // 4. Hand the REFERENCE (never the body's word for what happened) to the one shared function, which verifies
    //    with Paystack itself. The event is recorded so a redelivery is a no-op.
    const result = await fulfilTransaction(
      {
        reference: parsed.reference,
        source: "webhook",
        secretKey: deps.secretKey,
        webhookEvent: {
          eventType: parsed.event,
          providerTransactionId: String(parsed.evidence.id),
          providerStatus: parsed.evidence.status,
          txRef: parsed.reference.slice(0, 200),
          payload: parsed.evidence,
          receivedAt,
        },
      },
      { db: deps.db, fetch: deps.fetch },
    );

    return respondTo(result);
  } catch (error) {
    // Anything unexpected: say "try again later". Every step is idempotent, so a retry is safe.
    console.error("webhook: unexpected error:", error);
    return RETRY_LATER();
  }
}

function respondTo(result: FulfilResult): Response {
  switch (result.outcome) {
    case "fulfilled":
    case "already_fulfilled":
    case "duplicate_event":
    case "mismatch":
    case "not_paid":
      return json(200, { received: true });
    case "unknown":
      // A reference we never issued is final. But "ours, yet Paystack has no such transaction" can be a moment of
      // inconsistency on their side, so let Paystack try again.
      return result.reason === "not_ours" ? json(200, { received: true }) : RETRY_LATER();
    case "cannot_verify":
    case "write_failed":
      return RETRY_LATER();
  }
}
