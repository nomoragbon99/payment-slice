-- Switch from Flutterwave to Paystack: make the provider-specific column names provider-neutral
-- and record which provider each row is about. Written by hand: Prisma's generated version would
-- DROP COLUMN flw_transaction_id (losing its data); RENAME COLUMN keeps every value.

-- 1. Provider-neutral transaction id (was flw_transaction_id).
ALTER TABLE "payment_log"    RENAME COLUMN "flw_transaction_id" TO "provider_transaction_id";
ALTER TABLE "webhook_events" RENAME COLUMN "flw_transaction_id" TO "provider_transaction_id";

-- 2. Which provider a row is about. Existing rows (none in practice: no integration code ever ran)
-- are backfilled with 'paystack' through a temporary default, which is then dropped so that every
-- future insert must name its provider explicitly.
ALTER TABLE "payment_log"    ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'paystack';
ALTER TABLE "webhook_events" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'paystack';
ALTER TABLE "payment_log"    ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "webhook_events" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "payment_log"    ADD CONSTRAINT "payment_log_provider_valid"    CHECK (provider IN ('paystack'));
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_valid" CHECK (provider IN ('paystack'));

-- 3. Rename the CHECK that mentioned the old column name (same rule, provider-neutral name).
ALTER TABLE "payment_log" RENAME CONSTRAINT "payment_log_verified_has_flw_id" TO "payment_log_verified_has_provider_id";

-- 4. "One fulfilment per provider transaction": the id alone is ambiguous across providers, so the
-- unique index now covers (provider, provider_transaction_id).
DROP INDEX "payment_log_one_fulfilment_per_flw_id";
CREATE UNIQUE INDEX "payment_log_one_fulfilment_per_provider_id"
  ON "payment_log" ("provider", "provider_transaction_id") WHERE event_type = 'fulfilled';

-- 5. Webhook idempotency key now includes the provider. The new name is the one Prisma expects for
-- @@unique([provider, eventType, providerTransactionId, providerStatus]), so migrate diff shows no drift.
DROP INDEX "webhook_events_event_type_flw_transaction_id_provider_statu_key";
CREATE UNIQUE INDEX "webhook_events_provider_event_type_provider_transaction_id__key"
  ON "webhook_events" ("provider", "event_type", "provider_transaction_id", "provider_status");
