import path from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { imageSize } from 'image-size';
import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import type { CampaignModel as Campaign } from '../../../generated/prisma/models.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { notifyAdmins, pushCampaignLive } from '../notifications/notifications.service.js';
import * as entitlement from '../subscriptions/entitlement.service.js';
import { getCampaignRewardStats } from './campaign-stats.service.js';
import { toMoney, toMoneyString } from '../../utils/money.js';
import { getCampaignTypeFields, getCampaignUrlPolicy, validateCampaignUrl } from './campaign-type-fields.js';
import { generateApiKey } from '../../utils/apiKey.js';
import { restampTaskVerificationStrategies } from './campaign-tasks.service.js';

// The set of valid `campaignTypeCode` values createDraft/updateDraft accept
// - exposed so the create form can populate a real dropdown instead of a
// hardcoded guess at what codes exist in this environment's seed data.
// `fields` and `url` are the same per-type registry createDraft/createTask
// validate against (campaign-type-fields.ts), so the Agent form renders its
// dynamic fields (and the destination/video URL's label + required state)
// purely from this API response - adding a new campaign type never requires
// a frontend deploy just to know what inputs to show.
export async function listCampaignTypes() {
  const types = await prisma.campaignType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  return types.map((t) => ({ ...t, fields: getCampaignTypeFields(t.code), url: getCampaignUrlPolicy(t.code) }));
}

// Agent-facing read of the same admin-managed placement registry
// (spec §11's placement dropdown) - only enabled placements, since a
// disabled one wouldn't be served anyway (see admin-ads.service.ts for the
// admin-facing full list including disabled ones).
export function listEnabledPlacements() {
  return prisma.adPlacement.findMany({ where: { isEnabled: true }, orderBy: { code: 'asc' }, select: { code: true, name: true, description: true } });
}

async function ensureNotExpired(campaign: Campaign): Promise<Campaign> {
  if (campaign.status === 'ACTIVE' && campaign.expiresAt && campaign.expiresAt <= new Date()) {
    const updated = await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'EXPIRED' } });
    await prisma.subscriptionUsage.updateMany({
      where: { agentId: campaign.agentId },
      data: { campaignsExpired: { increment: 1 }, campaignsActive: { decrement: 1 } },
    });
    await writeAuditLog({ action: 'CAMPAIGN_EXPIRED', entityType: 'campaigns', entityId: updated.id });
    return updated;
  }
  return campaign;
}

async function ownedCampaignOrThrow(agentId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { campaignType: true } });
  if (!campaign || campaign.agentId !== agentId) throw Errors.notFound('Campaign');
  return campaign;
}

// campaign.agentId !== agentId above (via ownedCampaignOrThrow) is what
// actually prevents Agent B from touching Agent A's campaign - agentId here
// is always the caller's OWN AgentProfile id, derived server-side from the
// authenticated session (getAgentProfileByUserId), never accepted from the
// request body.
async function ownedCampaignWithStatus(agentId: string, campaignId: string, expected: string[]) {
  const campaign = await ownedCampaignOrThrow(agentId, campaignId);
  if (!expected.includes(campaign.status)) {
    throw Errors.conflict('INVALID_STATUS_TRANSITION', `Campaign must be ${expected.join(' or ')} for this action (currently ${campaign.status}).`);
  }
  return campaign;
}

export interface CreateCampaignInput {
  campaignTypeCode: string;
  campaignName: string;
  description?: string;
  objective?: string;
  platform?: string;
  creativeType?: string;
  imageUrl?: string;
  videoUrl?: string;
  destinationUrl?: string;
  cta?: string;
  completionLimit?: number | null;
  completionFrequency?: 'ONCE' | 'EVERY_TIME' | 'DAILY';
  // Website Promotion only - opts this campaign out of the in-app dwell
  // timer and into real on-site verification (see
  // website-verification.service.ts). Ignored for every other type.
  websiteVerificationEnabled?: boolean;
  // Banner/Image Promotion and Video Promotion only - true opens
  // destinationUrl/videoUrl in the external browser when the task is
  // tapped, false (default) shows the image/video full-screen in an in-app
  // modal instead and never opens the link. Ignored for every other type.
  openLinkInBrowser?: boolean;
  placement?: string | null;
}

// Whether a campaign of this type may use token-based on-site verification
// at all. Kept next to the input type rather than inlined at each call site
// so createDraft, updateDraft and the key-regeneration action all answer the
// question the same way.
function supportsWebsiteVerification(campaignTypeCode: string): boolean {
  return campaignTypeCode === 'WEBSITE_PROMOTION';
}

// The two types with a real image/video creative that can either be opened
// as a link or shown in an in-app modal - see Campaign.openLinkInBrowser.
// Every other type either has no such media (a social/product link) or is
// verified in a way that already dictates its own external open (App
// Promotion, Website Promotion's token flow, YouTube Subscribe).
function supportsOpenLinkToggle(campaignTypeCode: string): boolean {
  return campaignTypeCode === 'BANNER_IMAGE' || campaignTypeCode === 'VIDEO';
}

// The one campaign type whose target is not agent-entered data but a channel
// the agent has proven, through Google OAuth, that they control.
function isYouTubeSubscribe(campaignTypeCode: string): boolean {
  return campaignTypeCode === 'YOUTUBE_SUBSCRIBE';
}

// Spec §19/§3: a YOUTUBE_SUBSCRIBE campaign may only ever point at the
// channel on the owning agent's verified YouTubeConnection, and may not be
// created at all without one. Returning the channel fields (rather than just
// validating) is what makes scenario 9 - "campaign channel and agent
// connected channel do not match" - structurally impossible instead of a
// check that could be forgotten: there is no code path by which an
// agent-supplied channel id reaches the campaign row.
async function resolveYouTubeChannel(agentId: string) {
  const connection = await prisma.youTubeConnection.findUnique({ where: { agentId } });
  if (!connection) {
    throw Errors.conflict(
      'YOUTUBE_CHANNEL_NOT_CONNECTED',
      'Please connect and verify your YouTube channel before creating a YouTube Subscribe campaign.',
    );
  }
  return {
    youtubeChannelId: connection.youtubeChannelId,
    youtubeChannelName: connection.youtubeChannelName,
    youtubeChannelUrl: connection.channelUrl,
    // The generic column every client already opens for a task, pointed at
    // the verified channel - so the Ionic app needs no YouTube-specific
    // "where do I send the user" branch at all.
    destinationUrl: connection.channelUrl ?? `https://www.youtube.com/channel/${connection.youtubeChannelId}`,
  };
}

async function resolvePlacement(placement: string | null | undefined): Promise<string | null> {
  if (!placement) return null;
  // Any admin-managed placement code is a valid target, even a currently-
  // disabled one - disabling a placement only stops it being *served*
  // (ads.service.ts), it was never meant to retroactively invalidate a
  // campaign an agent already assigned to it.
  const exists = await prisma.adPlacement.findUnique({ where: { code: placement } });
  if (!exists) throw Errors.validation(`Unknown ad placement: ${placement}`);
  return placement;
}

export async function createDraft(agentId: string, input: CreateCampaignInput, userId?: string) {
  const campaignType = await prisma.campaignType.findUnique({ where: { code: input.campaignTypeCode } });
  if (!campaignType || !campaignType.isActive) throw Errors.validation('Unknown or inactive campaign type.');
  validateCampaignUrl(campaignType.code, input);

  // Banner Ads are a Professional-plan feature - the Angular nav/route already
  // hide this flow from agents who don't qualify, but that's UX only, so the
  // actual gate lives here where a direct API call can't bypass it.
  if (campaignType.code === 'BANNER_IMAGE') {
    const bannerAccess = await entitlement.canCreateBannerAd(agentId);
    if (!bannerAccess.allowed) throw Errors.forbidden(bannerAccess.message);
  }

  const subscription = await entitlement.getActiveSubscription(agentId);
  if (!subscription) throw Errors.conflict('NO_ACTIVE_SUBSCRIPTION', 'No active subscription. Please choose a plan before creating a campaign.');

  const placement = await resolvePlacement(input.placement);
  const websiteVerificationEnabled = supportsWebsiteVerification(campaignType.code) && input.websiteVerificationEnabled === true;
  const openLinkInBrowser = supportsOpenLinkToggle(campaignType.code) && input.openLinkInBrowser === true;
  // Resolved before the row is written, so a campaign either has a verified
  // channel from the moment it exists or is never created.
  const youtube = isYouTubeSubscribe(campaignType.code) ? await resolveYouTubeChannel(agentId) : null;

  const campaign = await prisma.campaign.create({
    data: {
      agentId,
      subscriptionId: subscription.id,
      campaignTypeId: campaignType.id,
      campaignName: input.campaignName,
      description: input.description,
      objective: input.objective,
      platform: input.platform,
      creativeType: input.creativeType,
      imageUrl: input.imageUrl,
      videoUrl: input.videoUrl,
      destinationUrl: input.destinationUrl,
      cta: input.cta,
      completionLimit: input.completionLimit,
      completionFrequency: input.completionFrequency ?? 'ONCE',
      openLinkInBrowser,
      // Spread last so it overrides any destinationUrl the client sent: for
      // this type the channel is the destination, and an agent-supplied URL
      // must never be able to send users somewhere other than the channel
      // their subscription will be checked against.
      ...(youtube ?? {}),
      // Only App Promotion campaigns get a callback credential - see
      // app-verification.service.ts for what it's used for.
      appVerificationApiKey: campaignType.code === 'APP_PROMOTION' ? generateApiKey() : undefined,
      // Website Promotion that opted in gets its site-side credential up
      // front, so the agent can copy it into their website's config the
      // moment the campaign exists - the key is what pairs with each
      // visitor's one-time token at POST /website-verification/confirm.
      ...(websiteVerificationEnabled ? { websiteVerificationEnabled: true, websiteVerificationApiKey: generateApiKey() } : {}),
      placement,
      status: 'DRAFT',
    },
  });

  await writeAuditLog({ userId, action: 'CAMPAIGN_DRAFT_CREATED', entityType: 'campaigns', entityId: campaign.id });
  return campaign;
}

export async function listMine(agentId: string, params: { page: number; pageSize: number; status?: string; q?: string; bannerAds?: 'only' | 'exclude' }) {
  // A Banner/Image Promotion campaign with a placement is a real Banner Ad
  // (see listCampaignsQuerySchema's `bannerAds` comment) - 'only' is the
  // Banner Ads list's filter, 'exclude' is Campaign Management's, so the
  // same underlying campaign type never shows up in both lists at once.
  const bannerAdCondition = { campaignType: { code: 'BANNER_IMAGE' as const }, placement: { not: null } };
  const where = {
    agentId,
    ...(params.status ? { status: params.status as any } : {}),
    ...(params.q ? { campaignName: { contains: params.q, mode: 'insensitive' as const } } : {}),
    ...(params.bannerAds === 'only' ? bannerAdCondition : {}),
    ...(params.bannerAds === 'exclude' ? { NOT: bannerAdCondition } : {}),
  };
  const [data, total] = await Promise.all([
    prisma.campaign.findMany({
      where,
      include: { campaignType: true },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.campaign.count({ where }),
  ]);
  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

// Aggregate counts for the agent's own campaign dashboard (spec Phase
// 5 §24, Phase 6 §18) - a status breakdown plus platform-wide totals across
// every campaign this agent owns, not a per-campaign funnel (that's
// getCampaignRewardStats, surfaced per-campaign via getMine below).
export async function getMyAnalytics(agentId: string) {
  const [statusCounts, participants, completedAgg, engagementAgg, campaigns] = await Promise.all([
    prisma.campaign.groupBy({ by: ['status'], where: { agentId }, _count: { _all: true } }),
    prisma.userTaskCompletion.findMany({
      where: { campaign: { agentId } },
      distinct: ['userId'],
      select: { userId: true },
    }),
    prisma.userTaskCompletion.aggregate({
      where: { campaign: { agentId }, status: 'COMPLETED' },
      _count: { _all: true },
      _sum: { rewardAmount: true },
    }),
    // View/click totals across all of the agent's campaigns (spec Phase 8
    // §3/§7) - both counters already live on Campaign, incremented at the
    // feed-detail fetch and the /tasks/:taskId/start call respectively.
    prisma.campaign.aggregate({
      where: { agentId },
      _sum: { viewCount: true, clickCount: true },
    }),
    // Per-campaign breakdown for the Agent's Campaign Analytics page -
    // completedCount is the same persisted "conversions" counter the feed
    // and admin views already rely on, not a separately computed value.
    prisma.campaign.findMany({
      where: { agentId },
      select: {
        id: true,
        campaignName: true,
        status: true,
        viewCount: true,
        clickCount: true,
        completedCount: true,
        campaignType: { select: { code: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) byStatus[row.status] = row._count._all;

  return {
    totalCampaigns: statusCounts.reduce((sum, row) => sum + row._count._all, 0),
    byStatus,
    totalParticipants: participants.length,
    totalTasksCompleted: completedAgg._count._all,
    totalRewardsGenerated: toMoney(completedAgg._sum.rewardAmount ?? 0),
    totalViews: engagementAgg._sum.viewCount ?? 0,
    totalClicks: engagementAgg._sum.clickCount ?? 0,
    campaignBreakdown: campaigns.map((c) => ({
      campaignId: c.id,
      campaignName: c.campaignName,
      status: c.status,
      campaignType: c.campaignType,
      views: c.viewCount,
      clicks: c.clickCount,
      conversions: c.completedCount,
      ctr: c.viewCount > 0 ? Number(((c.clickCount / c.viewCount) * 100).toFixed(2)) : 0,
    })),
  };
}

// Agent-facing, read-only equivalent of admin-participations.service.ts's
// listParticipations() - same UserTaskCompletion record, scoped to this
// agent's own campaigns instead of every campaign platform-wide. Agents can
// see who is completing their tasks and the status of each submission, but
// approving/rejecting a proof stays an Admin-only action (unchanged from
// the existing lifecycle-authority split).
export async function listMyParticipations(agentId: string, params: { page: number; pageSize: number; status?: string; campaignId?: string; search?: string }) {
  const where: any = {
    campaign: { agentId },
    ...(params.status ? { status: params.status } : {}),
    ...(params.campaignId ? { campaignId: params.campaignId } : {}),
    ...(params.search
      ? {
          OR: [
            { user: { name: { contains: params.search, mode: 'insensitive' } } },
            { user: { phone: { contains: params.search, mode: 'insensitive' } } },
            { campaign: { campaignName: { contains: params.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.userTaskCompletion.findMany({
      where,
      include: {
        user: { select: { id: true, phone: true, name: true } },
        task: { select: { id: true, title: true } },
        campaign: { select: { id: true, campaignName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.userTaskCompletion.count({ where }),
  ]);

  const data = rows.map((r) => ({
    id: r.id,
    user: r.user,
    campaign: r.campaign,
    task: r.task,
    status: r.status,
    rewardAmount: r.rewardAmount != null ? toMoneyString(r.rewardAmount) : null,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  }));

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

// Aggregate task-completion stats across this agent's campaigns (Agent Task
// Performance page) - a status breakdown plus a per-campaign rollup, both
// derived from the same UserTaskCompletion rows listMyParticipations()
// reads, just grouped instead of listed.
export async function getMyTaskPerformance(agentId: string) {
  const [statusCounts, perCampaignStatus] = await Promise.all([
    prisma.userTaskCompletion.groupBy({ by: ['status'], where: { campaign: { agentId } }, _count: { _all: true } }),
    prisma.userTaskCompletion.groupBy({ by: ['campaignId', 'status'], where: { campaign: { agentId } }, _count: { _all: true } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) byStatus[row.status] = row._count._all;
  const total = statusCounts.reduce((sum, row) => sum + row._count._all, 0);
  const completed = byStatus['COMPLETED'] ?? 0;

  const campaignIds = [...new Set(perCampaignStatus.map((r) => r.campaignId))];
  const campaignNames = campaignIds.length
    ? await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, campaignName: true } })
    : [];
  const nameById = new Map(campaignNames.map((c) => [c.id, c.campaignName]));

  const breakdown = campaignIds.map((campaignId) => {
    const rows = perCampaignStatus.filter((r) => r.campaignId === campaignId);
    const campaignTotal = rows.reduce((sum, r) => sum + r._count._all, 0);
    const campaignCompleted = rows.find((r) => r.status === 'COMPLETED')?._count._all ?? 0;
    return { campaignId, campaignName: nameById.get(campaignId) ?? 'Unknown campaign', total: campaignTotal, completed: campaignCompleted };
  });

  return {
    total,
    pending: byStatus['PENDING'] ?? 0,
    completed,
    rejected: byStatus['REJECTED'] ?? 0,
    expired: byStatus['EXPIRED'] ?? 0,
    completionRate: total > 0 ? Number(((completed / total) * 100).toFixed(0)) : 0,
    breakdown,
  };
}

export async function getMine(agentId: string, campaignId: string) {
  const campaign = await ownedCampaignOrThrow(agentId, campaignId);
  const current = await ensureNotExpired(campaign);
  const stats = await getCampaignRewardStats(campaignId);
  return { ...current, ...stats };
}

export async function updateDraft(agentId: string, campaignId: string, input: Partial<CreateCampaignInput>) {
  const campaign = await ownedCampaignOrThrow(agentId, campaignId);
  if (campaign.status !== 'DRAFT') throw Errors.conflict('NOT_EDITABLE', 'Only draft campaigns can be edited.');

  let campaignTypeId: string | undefined;
  let effectiveTypeCode = campaign.campaignType.code;
  if (input.campaignTypeCode) {
    const campaignType = await prisma.campaignType.findUnique({ where: { code: input.campaignTypeCode } });
    if (!campaignType || !campaignType.isActive) throw Errors.validation('Unknown or inactive campaign type.');
    campaignTypeId = campaignType.id;
    effectiveTypeCode = campaignType.code;
  }
  validateCampaignUrl(effectiveTypeCode, {
    destinationUrl: input.destinationUrl !== undefined ? input.destinationUrl : campaign.destinationUrl,
    videoUrl: input.videoUrl !== undefined ? input.videoUrl : campaign.videoUrl,
  });

  const placement = input.placement !== undefined ? await resolvePlacement(input.placement) : undefined;

  // Re-resolved on every save rather than carried forward: an agent who
  // switched an existing draft TO this type needs the channel stamped now,
  // and one who reconnected a different Google account since creating the
  // draft should have the draft follow their currently-verified channel. An
  // agent switching AWAY from this type has the columns cleared, so nothing
  // is left pointing at a channel the campaign no longer promotes.
  const youtube = isYouTubeSubscribe(effectiveTypeCode)
    ? await resolveYouTubeChannel(agentId)
    : campaign.youtubeChannelId
      ? { youtubeChannelId: null, youtubeChannelName: null, youtubeChannelUrl: null }
      : null;

  // Toggling on-site verification is only meaningful for the type that
  // supports it; switching a campaign to any other type silently clears it
  // rather than leaving a flag behind that nothing reads. The API key is
  // minted on first enable and then kept even if the toggle goes back off,
  // so an agent who flips it twice doesn't have to re-paste a new key into
  // their website.
  const websiteVerificationEnabled = supportsWebsiteVerification(effectiveTypeCode)
    ? input.websiteVerificationEnabled
    : campaign.websiteVerificationEnabled
      ? false
      : undefined;
  const needsApiKey = websiteVerificationEnabled === true && !campaign.websiteVerificationApiKey;

  // Same reasoning as websiteVerificationEnabled above: only meaningful for
  // the two types with a toggleable media link, and switching a draft away
  // from either one clears a flag nothing would read anymore.
  const openLinkInBrowser = supportsOpenLinkToggle(effectiveTypeCode)
    ? input.openLinkInBrowser
    : campaign.openLinkInBrowser
      ? false
      : undefined;

  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      campaignTypeId,
      campaignName: input.campaignName,
      description: input.description,
      objective: input.objective,
      platform: input.platform,
      creativeType: input.creativeType,
      imageUrl: input.imageUrl,
      videoUrl: input.videoUrl,
      destinationUrl: input.destinationUrl,
      cta: input.cta,
      completionLimit: input.completionLimit,
      completionFrequency: input.completionFrequency,
      // Same reasoning as createDraft: spread after destinationUrl so the
      // verified channel always wins over anything the client sent.
      ...(youtube ?? {}),
      websiteVerificationEnabled,
      openLinkInBrowser,
      ...(needsApiKey ? { websiteVerificationApiKey: generateApiKey() } : {}),
      placement,
    },
  });

  // A campaign's task is normally created after the campaign itself, so it
  // picks the right verification strategy up at creation time. Changing
  // either input to that decision afterwards - the campaign's type, or
  // Website Promotion's verification toggle - has to re-stamp whatever tasks
  // already exist, or the campaign keeps running the strategy it was created
  // with while the agent's form says otherwise.
  const toggleChanged = websiteVerificationEnabled !== undefined && websiteVerificationEnabled !== campaign.websiteVerificationEnabled;
  if (toggleChanged || effectiveTypeCode !== campaign.campaignType.code) {
    await restampTaskVerificationStrategies(campaignId, effectiveTypeCode, websiteVerificationEnabled ?? campaign.websiteVerificationEnabled);
  }

  return updated;
}

// Phase 13 §11: "Agent should be able to ... Upload banner/image." Only
// ever allowed on a DRAFT campaign, same rule as every other field edit
// above - reuses ownedCampaignOrThrow's ownership check rather than
// duplicating it.
// The extension is trustworthy here even though imageUrl is client-supplied
// input further up the stack: it comes from upload.ts's own multer storage
// config, which derives it from the sniffed mimetype rather than anything
// the client named the file, so a ".mp4" here really was a video file.
const VIDEO_UPLOAD_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);

// Banner Ads only (Phase: dedicated Banner Ads flow) - the ad slot that
// eventually shows this image (Ionic's <app-ad-slot>, .ad-slot-media) is a
// fixed short, wide box (object-fit: cover, max-height 140px), so a portrait
// or square upload would get badly cropped. 1200x400 (3:1) is the
// recommended size; the band below is deliberately generous around it
// rather than requiring an exact pixel match.
const BANNER_MIN_ASPECT_RATIO = 2.5;
const BANNER_MAX_ASPECT_RATIO = 3.5;
const BANNER_MIN_WIDTH_PX = 800;
const BANNER_DIMENSION_ERROR =
  'Banner image must be landscape with a width-to-height ratio between 2.5:1 and 3.5:1 (recommended: 1200x400px) and at least 800px wide.';

async function validateBannerImageDimensions(filePath: string): Promise<void> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    const buffer = await readFile(filePath);
    ({ width, height } = imageSize(buffer));
  } catch {
    // Falls through to the same rejection as an out-of-range image - an
    // unreadable/undetectable file is no more usable as a banner creative
    // than one with the wrong dimensions.
  }
  const ratio = width && height ? width / height : 0;
  if (!width || !height || width < BANNER_MIN_WIDTH_PX || ratio < BANNER_MIN_ASPECT_RATIO || ratio > BANNER_MAX_ASPECT_RATIO) {
    await unlink(filePath).catch(() => {});
    throw Errors.validation(BANNER_DIMENSION_ERROR);
  }
}

export async function setCreativeImage(agentId: string, campaignId: string, imageUrl: string, filePath: string) {
  const campaign = await ownedCampaignOrThrow(agentId, campaignId);
  if (campaign.status !== 'DRAFT') throw Errors.conflict('NOT_EDITABLE', 'Only draft campaigns can be edited.');
  // Only Video Promotion's creative upload may be a video file - every other
  // type still gets its ordinary image (upload.ts's 'campaigns' subdir
  // accepts both for every type since multer's fileFilter has no campaign
  // context to gate on; this is where that gets enforced).
  const isVideoFile = VIDEO_UPLOAD_EXTENSIONS.has(path.extname(imageUrl).toLowerCase());
  if (isVideoFile && campaign.campaignType.code !== 'VIDEO') {
    throw Errors.validation('A video file can only be uploaded for a Video Promotion campaign.');
  }
  // Only a Banner/Image Promotion campaign that actually has a placement is
  // headed for the small, fixed-shape <app-ad-slot> box (the dedicated
  // Banner Ads module always requires one) - a plain Banner/Image Promotion
  // campaign created from the generic Create Campaign form never gets a
  // placement and is shown full-screen in a modal instead (campaign-
  // detail.page.ts), where no particular aspect ratio is required. Gating on
  // `placement` rather than the type alone is what keeps this dimension
  // rule from applying to that form, which shares the exact same type code.
  if (!isVideoFile && campaign.campaignType.code === 'BANNER_IMAGE' && campaign.placement) {
    await validateBannerImageDimensions(filePath);
  }
  return prisma.campaign.update({ where: { id: campaignId }, data: { imageUrl } });
}

// A security-rotation action, not a content edit - deliberately allowed at
// any campaign status (not gated to DRAFT like setCreativeImage above), since
// an agent needs to be able to rotate a leaked key on a campaign that's
// already live.
export async function regenerateAppVerificationApiKey(agentId: string, campaignId: string) {
  const campaign = await ownedCampaignOrThrow(agentId, campaignId);
  if (campaign.campaignType.code !== 'APP_PROMOTION') {
    throw Errors.validation('Only App Promotion campaigns have an app verification API key.');
  }
  return prisma.campaign.update({ where: { id: campaignId }, data: { appVerificationApiKey: generateApiKey() } });
}

// Same rotation semantics as the App Promotion key above, and allowed at any
// campaign status for the same reason: a key that has leaked needs replacing
// on a campaign that is already live, not only on a draft. Rotating it
// invalidates nothing already earned - in-flight visitor tokens keep working,
// since a token is checked against the campaign it belongs to, and the key
// the site sends is only re-read on the next callback.
export async function regenerateWebsiteVerificationApiKey(agentId: string, campaignId: string) {
  const campaign = await ownedCampaignOrThrow(agentId, campaignId);
  if (!supportsWebsiteVerification(campaign.campaignType.code)) {
    throw Errors.validation('Only Website Promotion campaigns have a website verification API key.');
  }
  return prisma.campaign.update({ where: { id: campaignId }, data: { websiteVerificationApiKey: generateApiKey() } });
}

export async function removeDraft(agentId: string, campaignId: string) {
  const campaign = await ownedCampaignOrThrow(agentId, campaignId);
  if (campaign.status !== 'DRAFT') throw Errors.conflict('NOT_DELETABLE', 'Only draft campaigns can be deleted.');
  await prisma.campaign.delete({ where: { id: campaignId } });
}

// The one place the free-trial / campaign-limit rule is enforced. Nothing
// upstream of this (the DRAFT create/edit above) checks entitlement, exactly
// per the spec's "trial is consumed at submit, not at draft" rule.
export async function submit(agentId: string, campaignId: string) {
  const campaign = await ownedCampaignOrThrow(agentId, campaignId);
  if (campaign.status !== 'DRAFT') throw Errors.conflict('NOT_SUBMITTABLE', 'Only draft campaigns can be submitted.');
  if (campaign.campaignType.code === 'BANNER_IMAGE' && !campaign.imageUrl) {
    throw Errors.validation('An image upload is required for Banner / Image Promotion campaigns.');
  }

  const decision = await entitlement.canCreateCampaign(agentId);
  if (!decision.allowed) {
    throw Errors.conflict(decision.code ?? 'CAMPAIGN_CREATION_BLOCKED', decision.message);
  }

  const subscription = await entitlement.getActiveSubscription(agentId);
  if (!subscription) throw Errors.conflict('NO_ACTIVE_SUBSCRIPTION', 'No active subscription.');

  const [updated] = await prisma.$transaction([
    prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'PENDING_REVIEW', submittedAt: new Date(), subscriptionId: subscription.id },
    }),
    prisma.subscriptionUsage.update({
      where: { agentId },
      data: {
        campaignsCreated: { increment: 1 },
        lastCampaignCreatedAt: new Date(),
        trialUsed: subscription.plan.isFreeTrial ? true : undefined,
      },
    }),
    ...(subscription.plan.isFreeTrial
      ? [prisma.agentSubscription.update({ where: { id: subscription.id }, data: { trialUsed: true } })]
      : []),
  ]);

  await writeAuditLog({
    action: 'CAMPAIGN_SUBMITTED',
    entityType: 'campaigns',
    entityId: campaignId,
    metadata: { plan: subscription.plan.code },
  });

  const agent = await prisma.agentProfile.findUnique({ where: { id: agentId }, select: { name: true } });
  await notifyAdmins({
    type: 'CAMPAIGN_PENDING_APPROVAL',
    title: 'Campaign pending approval',
    message: `${agent?.name ?? 'An agent'} submitted "${updated.campaignName}" for review.`,
    metadata: { campaignId, agentId },
  });

  return updated;
}

// --- Operational lifecycle (Activate/Pause/Resume/Stop) ---------------
//
// Admin approval only answers "is this campaign allowed to run" -
// deciding *when* it actually runs belongs to the Agent who owns it, so
// these three functions (moved here from admin-campaigns.service.ts,
// unchanged in their actual transition logic) are now Agent-only. Resume
// is not a separate function: it's the exact same APPROVED/PAUSED -> ACTIVE
// transition as Activate, just starting from a different prior status.

export async function activate(userId: string, agentId: string, campaignId: string) {
  const campaign = await ownedCampaignWithStatus(agentId, campaignId, ['APPROVED', 'PAUSED']);

  const subscription = await prisma.agentSubscription.findUnique({
    where: { id: campaign.subscriptionId ?? undefined },
    include: { plan: true },
  });
  const durationHours = subscription ? entitlement.effectiveEntitlement(subscription).campaignDurationHours : 24;
  const wasPaused = campaign.status === 'PAUSED';

  const startsAt = wasPaused ? campaign.startsAt ?? new Date() : new Date();
  const expiresAt = new Date(startsAt.getTime() + durationHours * 60 * 60 * 1000);

  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'ACTIVE', startsAt, expiresAt },
  });

  if (!wasPaused) {
    await prisma.subscriptionUsage.updateMany({ where: { agentId }, data: { campaignsActive: { increment: 1 } } });
  }

  await writeAuditLog({
    userId,
    action: 'CAMPAIGN_ACTIVATED',
    entityType: 'campaigns',
    entityId: campaignId,
    metadata: { previousStatus: campaign.status },
  });

  // Tell users a new campaign is available - gated on !wasPaused, the same
  // flag the usage counter above uses, so pausing and resuming a campaign
  // over and over cannot be used to re-notify the entire user base. Each
  // campaign announces itself exactly once, when it first goes live.
  //
  // Not awaited: this fans out to every device on the platform and the
  // agent tapping "Activate" should not wait for it, nor see their campaign
  // fail to start because FCM was slow. pushCampaignLive() already logs and
  // contains its own failures.
  if (!wasPaused) {
    const topReward = await prisma.task.findFirst({
      where: { campaignId, status: 'ACTIVE' },
      orderBy: { rewardAmount: 'desc' },
      select: { rewardAmount: true },
    });
    void pushCampaignLive({
      campaignId,
      campaignName: updated.campaignName,
      rewardHint: topReward ? `up to ₹${toMoneyString(topReward.rewardAmount)}` : undefined,
    }).catch((err) => console.error('[campaigns.service] campaign-live push failed', { campaignId, reason: err?.message }));
  }

  return updated;
}

export async function pause(userId: string, agentId: string, campaignId: string) {
  const campaign = await ownedCampaignWithStatus(agentId, campaignId, ['ACTIVE']);
  const updated = await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'PAUSED' } });
  await writeAuditLog({
    userId,
    action: 'CAMPAIGN_PAUSED',
    entityType: 'campaigns',
    entityId: campaignId,
    metadata: { previousStatus: campaign.status },
  });
  return updated;
}

// Terminal - unlike Pause, a Stopped campaign never resumes (spec: "do not
// automatically allow Resume after STOPPED"). Reuses the existing but
// previously-unused CANCELLED status rather than adding a new enum value.
// Frees the agent's active-campaign slot the same way natural expiry does
// (ensureNotExpired above), since a stopped campaign is done for good just
// like an expired one.
export async function stop(userId: string, agentId: string, campaignId: string) {
  const campaign = await ownedCampaignWithStatus(agentId, campaignId, ['ACTIVE', 'PAUSED']);
  const updated = await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'CANCELLED' } });
  await prisma.subscriptionUsage.updateMany({ where: { agentId }, data: { campaignsActive: { decrement: 1 } } });
  await writeAuditLog({
    userId,
    action: 'CAMPAIGN_STOPPED',
    entityType: 'campaigns',
    entityId: campaignId,
    metadata: { previousStatus: campaign.status },
  });
  return updated;
}
