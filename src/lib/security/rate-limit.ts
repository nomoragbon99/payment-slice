import { db } from "@/lib/db";
import { errorResponse } from "@/lib/http";

type RateLimit = { windowSeconds: number; max: number };

export type ConsumeResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

// Exact sliding window: an attempt is allowed only if fewer than `max` ALLOWED attempts for this key
// happened in the last `windowSeconds` (see DECISIONS.md for why this replaced the fixed window).
//
// Counting rows and then inserting is not atomic on its own: two simultaneous requests could both
// count 4 and both insert, letting 6 through. So each attempt runs in one short transaction that
// first takes a per-key advisory lock. pg_advisory_xact_lock(n) is a named mutex held by the
// database: any other transaction asking for the same number waits until this one commits or rolls
// back, and the lock is then released automatically. Attempts for ONE key therefore run strictly one
// after another and each sees every earlier committed attempt when it counts. Different keys hash to
// different numbers and never wait for each other (a hash collision would only cause needless
// waiting, never a wrong count). The lock lives in the database, so it also works across processes.
//
// Only allowed attempts are stored. A denied attempt writes nothing, so hammering a blocked endpoint
// neither grows the table nor pushes the end of the block later: the block ends exactly when the
// oldest counted attempt turns `windowSeconds` old.
//
// Every time comparison uses the database clock (clock_timestamp()), never the app server's clock.
//
// Fails closed: if the database errors, this throws and the request is not allowed through.
export async function consume(key: string, limit: RateLimit): Promise<ConsumeResult> {
  const windowSeconds = limit.windowSeconds;

  return db.$transaction(
    async (tx) => {
      // 1. Wait for our turn on this key. Selecting from a subquery makes Prisma read a normal int
      //    back (pg_advisory_xact_lock itself returns void, which Prisma cannot deserialize).
      await tx.$queryRaw`
        SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) AS l
      `;

      // 2. Housekeeping: forget this key's attempts that are already outside the window. Nothing
      //    ever looks further back than the window, so this keeps the table tiny without a sweep job.
      await tx.$executeRaw`
        DELETE FROM rate_limit_attempts
        WHERE key = ${key}
          AND at <= clock_timestamp() - (${windowSeconds}::double precision * interval '1 second')
      `;

      // 3. How many attempts are inside the window, and when does the oldest one leave it?
      const rows = await tx.$queryRaw<{ count: number; retry_after: number | null }[]>`
        SELECT
          count(*)::int AS count,
          extract(epoch FROM (
            min(at) + (${windowSeconds}::double precision * interval '1 second') - clock_timestamp()
          ))::float8 AS retry_after
        FROM rate_limit_attempts
        WHERE key = ${key}
          AND at > clock_timestamp() - (${windowSeconds}::double precision * interval '1 second')
      `;
      const { count, retry_after } = rows[0];

      // 4a. Room left: record this attempt (the column default stamps it with clock_timestamp()).
      if (count < limit.max) {
        await tx.$executeRaw`INSERT INTO rate_limit_attempts (key) VALUES (${key})`;
        return { allowed: true, remaining: limit.max - count - 1, retryAfterSeconds: 0 };
      }

      // 4b. Full: store nothing. The block lifts when the oldest counted attempt ages out.
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(retry_after ?? windowSeconds)),
      };
    },
    // If something stalls while holding the lock, waiting requests give up (and fail closed) after 5 s.
    { maxWait: 5000, timeout: 5000 },
  );
}

export function rateLimitResponse(retryAfterSeconds: number) {
  const response = errorResponse(429, "RATE_LIMITED", "Too many requests. Please try again later.");
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}
