-- Centralizes the User reward per Campaign Type under Admin control
-- (Phase 5 update). Reused the existing campaign_types table rather than
-- adding a separate CampaignTypeRewardConfig table, since its `code`
-- column is already unique - "one active reward config per type" falls
-- out of that for free.
--
-- reward_amount seeded with sensible per-type defaults below (admin can
-- change any of them afterward); updated_at added as nullable+backfilled
-- rather than NOT NULL with no default, since this table already has rows.

ALTER TABLE "campaign_types" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE "campaign_types" ADD COLUMN "reward_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "campaign_types" ADD COLUMN "updated_by" UUID;
ALTER TABLE "campaign_types" ADD COLUMN "updated_at" TIMESTAMPTZ(6);

UPDATE "campaign_types" SET "reward_amount" = CASE "code"
  WHEN 'SURVEY' THEN 10.00
  WHEN 'APP_PROMOTION' THEN 25.00
  WHEN 'WEBSITE_PROMOTION' THEN 5.00
  WHEN 'VIDEO' THEN 15.00
  WHEN 'YOUTUBE_PROMOTION' THEN 10.00
  WHEN 'INSTAGRAM_PROMOTION' THEN 8.00
  WHEN 'FACEBOOK_PROMOTION' THEN 8.00
  WHEN 'BANNER' THEN 5.00
  WHEN 'TASK' THEN 5.00
  WHEN 'IMAGE' THEN 5.00
  WHEN 'PRODUCT_PROMOTION' THEN 10.00
  ELSE 5.00
END;

UPDATE "campaign_types" SET "updated_at" = NOW();
ALTER TABLE "campaign_types" ALTER COLUMN "updated_at" SET NOT NULL;
