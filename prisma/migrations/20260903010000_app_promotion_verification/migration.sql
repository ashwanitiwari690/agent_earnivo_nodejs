-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "app_verification_api_key" TEXT;

-- AlterTable
ALTER TABLE "user_task_completions" ADD COLUMN     "advertising_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_app_verification_api_key_key" ON "campaigns"("app_verification_api_key");

-- CreateIndex
CREATE INDEX "user_task_completions_advertising_id_idx" ON "user_task_completions"("advertising_id");

