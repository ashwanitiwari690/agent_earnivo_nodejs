-- CreateEnum
CREATE TYPE "AdProviderCode" AS ENUM ('INTERNAL', 'MOCK', 'GOOGLE', 'META');

-- CreateEnum
CREATE TYPE "AdEventType" AS ENUM ('IMPRESSION', 'CLICK');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "placement" TEXT,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "google_id" TEXT;

-- CreateTable
CREATE TABLE "ad_placements" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ad_placements_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ad_provider_config" (
    "provider" "AdProviderCode" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ad_provider_config_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "ad_events" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "user_id" UUID,
    "placement" TEXT NOT NULL,
    "type" "AdEventType" NOT NULL,
    "tracking_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ad_events_campaign_id_idx" ON "ad_events"("campaign_id");

-- CreateIndex
CREATE INDEX "ad_events_user_id_campaign_id_created_at_idx" ON "ad_events"("user_id", "campaign_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ad_events_tracking_id_type_key" ON "ad_events"("tracking_id", "type");

-- CreateIndex
CREATE INDEX "campaigns_placement_status_idx" ON "campaigns"("placement", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- AddForeignKey
ALTER TABLE "ad_events" ADD CONSTRAINT "ad_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_events" ADD CONSTRAINT "ad_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

