-- Phase 5: campaign operations & execution engine additions.
-- ARCHIVED is a new terminal status for admin-retired campaigns (their
-- history stays fully queryable - archiving never deletes or recalculates
-- anything). view_count backs basic per-campaign analytics. The two new
-- indexes support filtering/sorting campaigns by start time and by type
-- without a sequential scan as campaign volume grows.

ALTER TYPE "CampaignStatus" ADD VALUE 'ARCHIVED';

ALTER TABLE "campaigns" ADD COLUMN "view_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "campaigns_starts_at_idx" ON "campaigns"("starts_at");

CREATE INDEX "campaigns_campaign_type_id_idx" ON "campaigns"("campaign_type_id");
