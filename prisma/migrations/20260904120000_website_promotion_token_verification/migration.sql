-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "website_verification_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "website_verification_api_key" TEXT;

-- AlterTable
ALTER TABLE "user_task_completions" ADD COLUMN     "verification_token" TEXT,
ADD COLUMN     "verification_token_expires_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_website_verification_api_key_key" ON "campaigns"("website_verification_api_key");

-- CreateIndex
CREATE UNIQUE INDEX "user_task_completions_verification_token_key" ON "user_task_completions"("verification_token");
