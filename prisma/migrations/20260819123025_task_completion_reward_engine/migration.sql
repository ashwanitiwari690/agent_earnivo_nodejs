-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "TaskCompletionStatus" AS ENUM ('STARTED', 'SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'EXPIRED');

-- DropIndex
DROP INDEX "wallet_transactions_reference_type_reference_id_idx";

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "completed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "completion_limit" INTEGER;

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "instructions" TEXT,
    "reward_coins" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "status" "TaskStatus" NOT NULL DEFAULT 'ACTIVE',
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_task_completions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "status" "TaskCompletionStatus" NOT NULL DEFAULT 'STARTED',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "reward_coins" INTEGER,
    "verification_status" TEXT,
    "verification_data" JSONB NOT NULL DEFAULT '{}',
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_task_completions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_campaign_id_idx" ON "tasks"("campaign_id");

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX "user_task_completions_user_id_idx" ON "user_task_completions"("user_id");

-- CreateIndex
CREATE INDEX "user_task_completions_campaign_id_idx" ON "user_task_completions"("campaign_id");

-- CreateIndex
CREATE INDEX "user_task_completions_status_idx" ON "user_task_completions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "user_task_completions_user_id_task_id_key" ON "user_task_completions"("user_id", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_reference_type_reference_id_key" ON "wallet_transactions"("reference_type", "reference_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_task_completions" ADD CONSTRAINT "user_task_completions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_task_completions" ADD CONSTRAINT "user_task_completions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_task_completions" ADD CONSTRAINT "user_task_completions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

