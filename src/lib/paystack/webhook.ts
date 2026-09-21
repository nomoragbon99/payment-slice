import { createHmac, timingSafeEqual } from "crypto";
import { transactionEvidenceSchema, type TransactionEvidence } from "@/lib/paystack/evidence";

// Paystack webhooks. Confirmed against two real test-mode deliveries:
//   * the x-paystack-signature header is HMAC-SHA512 (lowercase hex, 128 characters) of the RAW request body
//     bytes, keyed with the SECRET KEY. There is no separate webhook secret;
//   * the body is { "event": "charge.success", "data": { "id": <number>, "reference": ..., "status": "success",
//     "amount": <integer kobo>, "currency": ..., ... } } with no separate event id (data.id is the TRANSACTION id).

export const CHARGE_SUCCESS = "charge.success";

// Real bodies are about 1.3 KB; anything near this size is not Paystack.
export const MAX_WEBHOOK_BYTES = 64 * 1024;

// The signature is computed over the exact bytes Paystack sent, so it must be checked against the RAW bytes,
// BEFORE anything is parsed: parsing and re-serialising can change whitespace or escaping and would break it
// (and would mean acting on unauthenticated input). The comparison is constant-time. The header must be
// exactly what a lowercase-hex SHA-512 looks like: anything else (wrong length, uppercase, an HMAC-SHA256)
// simply does not equal the expected string.
export function isValidWebhookSignature(rawBody: Buffer, header: string | null | undefined, secretKey: string): boolean {
  if (!header || !secretKey) return false;
  const expected = Buffer.from(createHmac("sha512", secretKey).update(rawBody).digest("hex"), "utf8");
  const received = Buffer.from(header, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export type ParsedWebhook =
  // Signed, but not a body we can act on (not JSON, not an object, no event name, or a charge.success without the
  // fields we need). Retrying the same bytes cannot help, so the handler answers 400.
  | { kind: "malformed" }
  // A well-formed event of a type this app does not handle (transfers, refunds, disputes ...): acknowledged, not stored.
  | { kind: "ignored"; event: string }
  // charge.success: `evidence` is the TRIMMED transaction (never card or customer details), see evidence.ts.
  | { kind: "charge_success"; event: string; reference: string; evidence: TransactionEvidence };

// Only called AFTER the signature has been verified.
export function parseWebhookBody(rawBody: Buffer): ParsedWebhook {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { kind: "malformed" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "malformed" };

  const { event, data } = body as { event?: unknown; data?: unknown };
  if (typeof event !== "string" || event.length === 0 || event.length > 100) return { kind: "malformed" };
  if (event !== CHARGE_SUCCESS) return { kind: "ignored", event };

  // zod strips everything except the 9 evidence fields, so card and customer details are dropped right here.
  const evidence = transactionEvidenceSchema.safeParse(data);
  if (!evidence.success) return { kind: "malformed" };
  return { kind: "charge_success", event, reference: evidence.data.reference, evidence: evidence.data };
}
