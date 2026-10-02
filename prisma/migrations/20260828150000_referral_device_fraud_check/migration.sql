-- AlterTable
ALTER TABLE "referrals" ADD COLUMN     "device_id" TEXT;

-- CreateIndex
CREATE INDEX "referrals_device_id_idx" ON "referrals"("device_id");

