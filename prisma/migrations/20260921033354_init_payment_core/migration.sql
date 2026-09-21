-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "plan_id" TEXT NOT NULL,
    "billing_interval" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "current_period_start" TIMESTAMPTZ NOT NULL,
    "current_period_end" TIMESTAMPTZ NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "cancellation_reason" TEXT,
    "last_tx_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "plan_id" TEXT NOT NULL,
    "billing_interval" TEXT NOT NULL,
    "tx_ref" TEXT NOT NULL,
    "flw_transaction_id" TEXT,
    "event_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "raw_response" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" TEXT NOT NULL,
    "flw_transaction_id" TEXT NOT NULL,
    "provider_status" TEXT NOT NULL,
    "tx_ref" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "outcome" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "payment_log_tx_ref_idx" ON "payment_log"("tx_ref");

-- CreateIndex
CREATE INDEX "payment_log_user_id_created_at_idx" ON "payment_log"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_event_type_flw_transaction_id_provider_statu_key" ON "webhook_events"("event_type", "flw_transaction_id", "provider_status");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written below: Prisma cannot express CHECK constraints, partial unique
-- indexes or triggers. Each one exists so that an invalid state is impossible
-- at the database level, not just unlikely in the app.
-- ============================================================================

-- users: emails are stored trimmed and lowercased by the app; this CHECK is the actual
-- guarantee, since a raw SQL script or a future bug cannot bypass it.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase_trimmed" CHECK (email = lower(btrim(email)));
ALTER TABLE "users" ADD CONSTRAINT "users_name_length" CHECK (char_length(name) BETWEEN 1 AND 80);

-- subscriptions: "no row" means free, so every row is a paid 'pro' period.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_is_pro" CHECK (plan_id = 'pro');
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_interval_valid" CHECK (billing_interval IN ('monthly', 'yearly'));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_status_valid" CHECK (status IN ('active', 'past_due', 'canceled'));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_period_ordered" CHECK (current_period_end > current_period_start);
-- A cancellation reason only makes sense when the subscription is cancelled or scheduled to cancel.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_reason_needs_cancellation" CHECK (cancellation_reason IS NULL OR cancel_at_period_end OR status = 'canceled');
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_reason_length" CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) BETWEEN 1 AND 500);

-- payment_log: money and lifecycle rules.
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_plan_is_pro" CHECK (plan_id = 'pro');
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_interval_valid" CHECK (billing_interval IN ('monthly', 'yearly'));
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_event_type_valid" CHECK (event_type IN ('initiated', 'verified', 'fulfilled', 'failed'));
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_status_valid" CHECK (status IN ('pending', 'successful', 'failed'));
-- Amounts are integer kobo and must be positive.
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_amount_positive" CHECK (amount > 0);
-- Currency is a 3-letter uppercase code (ISO 4217 shape); the app restricts it further.
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_currency_format" CHECK (currency ~ '^[A-Z]{3}$');
-- Event type and status must agree.
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_initiated_is_pending" CHECK (event_type <> 'initiated' OR status = 'pending');
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_fulfilled_is_successful" CHECK (event_type <> 'fulfilled' OR status = 'successful');
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_failed_is_failed" CHECK (event_type <> 'failed' OR status = 'failed');
-- Once Flutterwave has been asked about a transaction, its id is known.
ALTER TABLE "payment_log" ADD CONSTRAINT "payment_log_verified_has_flw_id" CHECK (event_type NOT IN ('verified', 'fulfilled') OR flw_transaction_id IS NOT NULL);

-- A transaction can be fulfilled at most once, whichever path gets there first (webhook or the
-- return-URL check). This covers the return-URL path, which never touches webhook_events.
CREATE UNIQUE INDEX "payment_log_one_fulfilment_per_tx_ref" ON "payment_log" ("tx_ref") WHERE event_type = 'fulfilled';
CREATE UNIQUE INDEX "payment_log_one_fulfilment_per_flw_id" ON "payment_log" ("flw_transaction_id") WHERE event_type = 'fulfilled';

-- payment_log is append-only: reject UPDATE, DELETE and TRUNCATE. FOR EACH STATEMENT so that even a
-- statement that matches zero rows is rejected, and TRUNCATE (which row triggers never see) is covered.
CREATE FUNCTION payment_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_log is append-only: % is not allowed (add a new row instead)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "payment_log_append_only"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "payment_log"
  FOR EACH STATEMENT EXECUTE FUNCTION payment_log_reject_mutation();

-- webhook_events: "finished" and "what we did" always go together.
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_outcome_valid" CHECK (outcome IS NULL OR outcome IN ('fulfilled', 'already_fulfilled', 'verification_failed', 'amount_mismatch', 'unknown_tx_ref'));
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_processed_iff_outcome" CHECK ((processed_at IS NULL) = (outcome IS NULL));
