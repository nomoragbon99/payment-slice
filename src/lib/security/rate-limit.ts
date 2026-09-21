import { checkoutConfig } from "@/config/checkout";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/http";

type RateLimit = { windowSeconds: number; max: number };

export type ConsumeResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

// Fixed window, not sliding: each key gets one row per windowSeconds-wide bucket. Chosen over a
// sliding window because it needs one row and one atomic statement per key. Trade-off (recorded
// in DECISIONS.md): a client can burst up to 2x max requests across a window boundary (max at the
// end of one window, max again at the start of the next).
export async function consume(key: string, limit: RateLimit): Promise<ConsumeResult> {
  const windowMs = limit.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);

  // One atomic parameterised statement: INSERT the first hit in this window, or increment the
  // existing row's count, and return the resulting count -- no read-then-write race between
  // concurrent requests for the same key.
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limit_buckets (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count
  `;
  const count = rows[0].count;

  void cleanupOldBucketsOncePerInterval();

  const allowed = count <= limit.max;
  const remaining = Math.max(0, limit.max - count);
  const retryAfterSeconds = allowed
    ? 0
    : Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000);

  return { allowed, remaining, retryAfterSeconds };
}

export function rateLimitResponse(retryAfterSeconds: number) {
  const response = errorResponse(429, "RATE_LIMITED", "Too many requests. Please try again later.");
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

let lastCleanupAt = 0;

// Opportunistic cleanup, at most once per interval per process: piggybacks on a normal request
// instead of needing a scheduled job at this slice's scale. Called fire-and-forget, so it must catch
// its own errors: a failed sweep is not worth failing (or slowing) the request that triggered it.
async function cleanupOldBucketsOncePerInterval(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < checkoutConfig.rateLimitCleanup.intervalSeconds * 1000) return;
  lastCleanupAt = now;

  try {
    await db.rateLimitBucket.deleteMany({
      where: {
        windowStart: { lt: new Date(now - checkoutConfig.rateLimitCleanup.bucketRetentionSeconds * 1000) },
      },
    });
  } catch (error) {
    console.error("rate-limit bucket cleanup failed:", error);
  }
}
