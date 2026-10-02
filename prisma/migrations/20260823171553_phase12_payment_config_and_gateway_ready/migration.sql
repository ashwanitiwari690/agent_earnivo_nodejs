-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'MANUAL_QR',
ADD COLUMN     "provider_transaction_id" TEXT;

-- AlterTable
ALTER TABLE "platform_payment_config" ADD COLUMN     "is_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "minimum_amount" DECIMAL(12,2),
ADD COLUMN     "payment_notes" TEXT,
ADD COLUMN     "supported_methods" TEXT[];

-- Prevent duplicate transaction ID (spec Phase 12 §7). Partial unique index
-- so a REJECTED payment's reference can be legitimately reused on resubmit;
-- Prisma's schema DSL has no way to express a partial index declaratively,
-- so this is hand-written only (see the comment on Payment in schema.prisma).
CREATE UNIQUE INDEX "payments_transaction_reference_active_unique"
ON "payments" ("transaction_reference")
WHERE "status" <> 'REJECTED';

