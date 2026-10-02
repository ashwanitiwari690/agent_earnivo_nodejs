import { z } from 'zod';

// ₹1,00,000 - generous ceiling for a campaign-type reward that still catches
// fat-finger/overflow entries; DECIMAL(12,2) itself allows far more.
const MAX_REWARD_AMOUNT = 100000;

// Admin-only (campaign-type reward config): zero is a valid "no reward"
// setting for a type, so this allows 0 where the old per-task input didn't.
export const campaignTypeRewardAmountSchema = z.coerce
  .number()
  .finite({ message: 'Reward amount must be a finite number' })
  .nonnegative({ message: 'Reward amount cannot be negative' })
  .max(MAX_REWARD_AMOUNT, { message: `Reward amount cannot exceed ₹${MAX_REWARD_AMOUNT}` })
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, {
    message: 'Reward amount supports at most 2 decimal places',
  });

export const createCampaignSchema = z.object({
  campaignTypeCode: z.string().min(2).max(50),
  campaignName: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional(),
  objective: z.string().trim().max(500).optional(),
  platform: z.string().trim().max(100).optional(),
  creativeType: z.string().trim().max(50).optional(),
  imageUrl: z.string().trim().url().max(500).optional(),
  videoUrl: z.string().trim().url().max(500).optional(),
  destinationUrl: z.string().trim().url().max(500).optional(),
  cta: z.string().trim().max(50).optional(),
  completionLimit: z.coerce.number().int().min(1).nullable().optional(),
  // Display Visibility (Once / Every Day): agent-chosen reward repeatability
  // for this campaign's task(s) - see UserTaskCompletion.cycleDate.
  completionFrequency: z.enum(['ONCE', 'EVERY_TIME', 'DAILY']).optional(),
  // Website Promotion's on-site verification toggle: when true the reward is
  // credited only by the agent's own site calling POST
  // /website-verification/confirm, never by the in-app dwell timer. Accepted
  // for any type but only honoured for Website Promotion - campaigns.service
  // .ts decides that, not this schema.
  websiteVerificationEnabled: z.boolean().optional(),
  // Banner/Image Promotion and Video Promotion only: whether tapping the
  // task opens destinationUrl/videoUrl in the external browser (true) or
  // shows the image/video full-screen inside an in-app modal instead
  // (false, the default). Accepted for any type but only honoured for those
  // two - campaigns.service.ts decides that, not this schema.
  openLinkInBrowser: z.boolean().optional(),
  // Phase 13 §11: an agent may opt this campaign into the ad-delivery
  // engine by choosing a placement; validated against the admin-managed
  // AdPlacement registry in campaigns.service.ts, not just this pattern.
  // `priority` is deliberately NOT agent-settable (spec §13: priority is an
  // Admin-managed control) - it stays at its schema default (0) here.
  placement: z.string().trim().min(2).max(50).nullable().optional(),
});

export const updateCampaignSchema = createCampaignSchema.partial();

export const listCampaignsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.string().optional(),
  q: z.string().trim().max(200).optional(),
  // Banner/Image Promotion campaigns with a `placement` are real Banner Ads
  // (created only by the dedicated Banner Ads module, which requires one) -
  // the same campaignType.code as a plain Banner/Image Promotion campaign
  // from the generic Create Campaign form (which never has a placement), so
  // this is what actually tells the two apart. 'only' is the Banner Ads
  // list's own dedicated GET /campaigns call; 'exclude' is Campaign
  // Management's, so Banner Ads never doubles up in both lists. Omitted,
  // this behaves exactly as before (every campaign returned).
  bannerAds: z.enum(['only', 'exclude']).optional(),
});

export const listMyParticipationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.string().optional(),
  campaignId: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
});

// Deliberately no `rewardAmount` field: the User reward is no longer agent-
// entered (Phase 5 update). Zod strips unrecognized keys by default, so
// even a client that still sends one gets it silently dropped before this
// ever reaches the service layer - see campaign-tasks.service.ts, which
// derives the reward from the campaign's type instead.
export const createTaskSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(1000).optional(),
  type: z.string().trim().min(2).max(50),
  instructions: z.string().trim().max(2000).optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  isRequired: z.boolean().optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
  // SURVEY only - real shape validation happens in
  // campaign-type-fields.ts's validateSurveyQuestions, not here.
  questions: z.array(z.unknown()).optional(),
});

export const updateTaskSchema = createTaskSchema.partial();

export const updateCampaignTypeRewardSchema = z.object({
  rewardAmount: campaignTypeRewardAmountSchema,
  currency: z.literal('INR').optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.coerce.number().int().optional(),
});
