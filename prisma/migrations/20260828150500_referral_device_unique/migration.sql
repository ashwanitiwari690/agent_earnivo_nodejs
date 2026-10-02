-- DropIndex
DROP INDEX "referrals_device_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "referrals_device_id_key" ON "referrals"("device_id");

