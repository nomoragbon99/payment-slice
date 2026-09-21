-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key","window_start")
);

-- Hand-written: Prisma cannot express CHECK constraints.
-- A bucket row exists only because an attempt happened, so its count is always at least 1. A zero or
-- negative count would mean "this many attempts" makes no sense and could grant free extra attempts.
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_count_positive" CHECK (count > 0);
