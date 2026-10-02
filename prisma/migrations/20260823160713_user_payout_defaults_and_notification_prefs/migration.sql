-- AlterTable
ALTER TABLE "users" ADD COLUMN     "default_mobile_number" TEXT,
ADD COLUMN     "default_payout_method" TEXT,
ADD COLUMN     "default_upi_id" TEXT,
ADD COLUMN     "notify_account" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notify_campaigns" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notify_rewards" BOOLEAN NOT NULL DEFAULT true;
