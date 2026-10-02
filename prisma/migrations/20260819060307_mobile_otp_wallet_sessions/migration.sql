/*
  Warnings:

  - Added the required column `updated_at` to the `refresh_tokens` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('EARN', 'BONUS', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "app_version" TEXT,
ADD COLUMN     "device_id" TEXT,
ADD COLUMN     "platform" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6);
UPDATE "refresh_tokens" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
ALTER TABLE "refresh_tokens" ALTER COLUMN "updated_at" SET NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_login_at" TIMESTAMPTZ(6),
ADD COLUMN     "phone_verified" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "otp_verifications" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "coin_balance" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference_type" TEXT,
    "reference_id" UUID,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "otp_verifications_phone_idx" ON "otp_verifications"("phone");

-- CreateIndex
CREATE INDEX "otp_verifications_created_at_idx" ON "otp_verifications"("created_at");

-- CreateIndex
CREATE INDEX "otp_verifications_expires_at_idx" ON "otp_verifications"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_wallets_user_id_key" ON "user_wallets"("user_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_user_id_idx" ON "wallet_transactions"("user_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_reference_type_reference_id_idx" ON "wallet_transactions"("reference_type", "reference_id");

-- AddForeignKey
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
