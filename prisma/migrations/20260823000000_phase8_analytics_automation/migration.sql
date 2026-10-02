-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "click_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "agent_subscriptions_expires_at_idx" ON "agent_subscriptions"("expires_at");

-- CreateIndex
CREATE INDEX "payments_transaction_reference_idx" ON "payments"("transaction_reference");

