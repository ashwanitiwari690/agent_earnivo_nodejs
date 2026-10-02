-- AlterTable
ALTER TABLE "agent_subscriptions" ADD COLUMN     "amount_paid" DECIMAL(12,2),
ADD COLUMN     "billing_cycle" "BillingCycle";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "billing_cycle" "BillingCycle";

-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "offer_percent" INTEGER NOT NULL DEFAULT 0;
