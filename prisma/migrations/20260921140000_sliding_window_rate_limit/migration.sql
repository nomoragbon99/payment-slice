-- Replace the fixed-window rate limiter with an exact sliding window (see DECISIONS.md, "Rate
-- limiting: exact sliding window replaces the fixed window"). The migration that created
-- rate_limit_buckets is left untouched as history; this one supersedes it.

-- New table: one row per ALLOWED attempt, so per key it never holds more than the limit.
CREATE TABLE "rate_limit_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    -- clock_timestamp() (time of the statement), not now() (start of the transaction): a request
    -- that waited for the per-key lock must not be stamped earlier than attempts committed before it.
    "at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "rate_limit_attempts_pkey" PRIMARY KEY ("id")
);

-- The only query is "this key's attempts newer than a cutoff".
CREATE INDEX "rate_limit_attempts_key_at_idx" ON "rate_limit_attempts"("key", "at");

-- Old table: it only held short-lived counters (safe to discard), and it was empty when this was written.
DROP TABLE "rate_limit_buckets";
