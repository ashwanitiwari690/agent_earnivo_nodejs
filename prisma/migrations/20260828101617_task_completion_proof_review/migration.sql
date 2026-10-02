-- AlterTable
ALTER TABLE "user_task_completions" ADD COLUMN     "proof_image_url" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(6),
ADD COLUMN     "reviewed_by" UUID;

-- AddForeignKey
ALTER TABLE "user_task_completions" ADD CONSTRAINT "user_task_completions_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

