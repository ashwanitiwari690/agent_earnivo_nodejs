-- DropIndex
DROP INDEX "notifications_created_at_idx";

-- DropIndex
DROP INDEX "referrals_referrer_id_idx";

-- DropIndex
DROP INDEX "user_task_completions_user_id_idx";

-- DropIndex
DROP INDEX "wallet_transactions_user_id_idx";

-- DropIndex
DROP INDEX "withdrawals_user_id_idx";

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "referrals_referrer_id_created_at_idx" ON "referrals"("referrer_id", "created_at");

-- CreateIndex
CREATE INDEX "user_task_completions_user_id_created_at_idx" ON "user_task_completions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_user_id_created_at_idx" ON "wallet_transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "withdrawals_user_id_created_at_idx" ON "withdrawals"("user_id", "created_at");

