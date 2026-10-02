-- CreateEnum
CREATE TYPE "GoogleConnectionOwnerType" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "GoogleConnectionStatus" AS ENUM ('CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "YouTubeVerificationStatus" AS ENUM ('WAITING_FOR_VERIFICATION', 'VERIFIED');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "youtube_channel_id" TEXT,
ADD COLUMN     "youtube_channel_name" TEXT,
ADD COLUMN     "youtube_channel_url" TEXT;

-- CreateTable
CREATE TABLE "google_account_connections" (
    "id" UUID NOT NULL,
    "owner_type" "GoogleConnectionOwnerType" NOT NULL,
    "user_id" UUID,
    "agent_id" UUID,
    "google_account_id" TEXT NOT NULL,
    "email" TEXT,
    "access_token_encrypted" TEXT,
    "refresh_token_encrypted" TEXT,
    "token_expiry" TIMESTAMPTZ(6),
    "scopes" TEXT[],
    "status" "GoogleConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "last_refreshed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "google_account_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_connections" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "google_connection_id" UUID NOT NULL,
    "youtube_channel_id" TEXT NOT NULL,
    "youtube_channel_name" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "channel_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "youtube_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_task_verifications" (
    "id" UUID NOT NULL,
    "completion_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "youtube_channel_id" TEXT NOT NULL,
    "status" "YouTubeVerificationStatus" NOT NULL DEFAULT 'WAITING_FOR_VERIFICATION',
    "verification_method" TEXT NOT NULL DEFAULT 'YOUTUBE_OAUTH',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_failure_reason" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "last_verification_attempt_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "youtube_task_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_account_connections_user_id_key" ON "google_account_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "google_account_connections_agent_id_key" ON "google_account_connections"("agent_id");

-- CreateIndex
CREATE INDEX "google_account_connections_google_account_id_idx" ON "google_account_connections"("google_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_connections_agent_id_key" ON "youtube_connections"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_connections_google_connection_id_key" ON "youtube_connections"("google_connection_id");

-- CreateIndex
CREATE INDEX "youtube_connections_youtube_channel_id_idx" ON "youtube_connections"("youtube_channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_task_verifications_completion_id_key" ON "youtube_task_verifications"("completion_id");

-- CreateIndex
CREATE INDEX "youtube_task_verifications_user_id_campaign_id_idx" ON "youtube_task_verifications"("user_id", "campaign_id");

-- CreateIndex
CREATE INDEX "youtube_task_verifications_status_idx" ON "youtube_task_verifications"("status");

-- AddForeignKey
ALTER TABLE "google_account_connections" ADD CONSTRAINT "google_account_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_account_connections" ADD CONSTRAINT "google_account_connections_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_connections" ADD CONSTRAINT "youtube_connections_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_connections" ADD CONSTRAINT "youtube_connections_google_connection_id_fkey" FOREIGN KEY ("google_connection_id") REFERENCES "google_account_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_task_verifications" ADD CONSTRAINT "youtube_task_verifications_completion_id_fkey" FOREIGN KEY ("completion_id") REFERENCES "user_task_completions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
