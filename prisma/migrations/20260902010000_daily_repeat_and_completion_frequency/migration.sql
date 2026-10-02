-- CreateEnum
CREATE TYPE "CampaignCompletionFrequency" AS ENUM ('ONCE', 'DAILY');

-- DropIndex
DROP INDEX "user_task_completions_user_id_task_id_key";

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "completion_frequency" "CampaignCompletionFrequency" NOT NULL DEFAULT 'ONCE';

-- AlterTable
ALTER TABLE "user_task_completions" ADD COLUMN     "cycle_date" TEXT NOT NULL DEFAULT 'ONCE';

-- CreateIndex
CREATE UNIQUE INDEX "user_task_completions_user_id_task_id_cycle_date_key" ON "user_task_completions"("user_id", "task_id", "cycle_date");

