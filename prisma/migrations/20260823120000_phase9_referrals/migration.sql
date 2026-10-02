-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('OTP_VERIFIED', 'QUALIFIED', 'REWARDED', 'REJECTED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "referral_click_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referral_code" TEXT;

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "referrer_id" UUID NOT NULL,
    "referred_user_id" UUID NOT NULL,
    "referral_code" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'OTP_VERIFIED',
    "reward_amount" DECIMAL(12,2),
    "qualified_at" TIMESTAMPTZ(6),
    "rewarded_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_config" (
    "id" UUID NOT NULL,
    "reward_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "qualification_rule" TEXT NOT NULL DEFAULT 'OTP_VERIFIED',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "referral_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referred_user_id_key" ON "referrals"("referred_user_id");

-- CreateIndex
CREATE INDEX "referrals_referrer_id_idx" ON "referrals"("referrer_id");

-- CreateIndex
CREATE INDEX "referrals_status_idx" ON "referrals"("status");

-- CreateIndex
CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_user_id_fkey" FOREIGN KEY ("referred_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

