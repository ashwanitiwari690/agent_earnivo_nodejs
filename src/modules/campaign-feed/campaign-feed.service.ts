import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { Errors } from '../../utils/AppError.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { sumDecimal, toMoney, toMoneyString } from '../../utils/money.js';
import { resolveTaskStrategy } from '../tasks/verification.service.js';
import { currentCycleDate, EVERY_TIME_COOLDOWN_MS, findCurrentCompletion } from '../tasks/eligibility.service.js';

// Decimal, not the serialized string, so callers (sort comparators) can do
// real numeric comparison instead of comparing "10.00" > "9.00" as strings.
function totalRewardOf(campaign: any) {
  return sumDecimal((campaign.tasks ?? []).map((t: any) => t.rewardAmount));
}

// Whitelist-only: agent id, subscription id, rejection reason, approval
// timestamps and anything else internal to the review workflow never
// reaches the user feed (spec §3).
function serializeCampaignSummary(campaign: any) {
  const durationHours =
    campaign.startsAt && campaign.expiresAt
      ? Math.round((campaign.expiresAt.getTime() - campaign.startsAt.getTime()) / (60 * 60 * 1000))
      : null;

  return {
    id: campaign.id,
    title: campaign.campaignName,
    description: campaign.description,
    type: campaign.campaignType.code,
    imageUrl: campaign.imageUrl,
    videoUrl: campaign.videoUrl,
    taskCount: campaign.tasks?.length ?? 0,
    // Total of every active task's agent-set reward - the exact amount the
    // user earns for finishing the whole campaign. Never recomputed or
    // accepted from the client anywhere downstream (spec §7/§9/§18).
    reward: toMoney(totalRewardOf(campaign)),
    durationHours,
    endsAt: campaign.expiresAt,
    // How often the same user may earn this campaign's rewards - the client
    // needs it to decide whether a finished task offers "Do It Again"
    // (EVERY_TIME), "come back tomorrow" (DAILY) or nothing at all (ONCE).
    // Enforcement itself is server-side (eligibility.service.ts's cycleDate);
    // this is purely so the app can describe the rule it will be held to.
    completionFrequency: campaign.completionFrequency,
  };
}

// Which completion row "counts" as this user's current status on a task,
// matching exactly what checkTaskEligibility/startTask would see right now
// - without this, a returning visitor's PENDING (or COMPLETED/REJECTED)
// attempt would be invisible to the page, which would then wrongly offer
// "Start Task" again instead of reflecting the real state. The rule itself
// lives in eligibility.service.ts, so the feed and the verification paths
// can never drift on which attempt they mean.
function getMyCompletion(userId: string, campaign: any, taskId: string) {
  return findCurrentCompletion(userId, taskId, campaign.completionFrequency);
}

function serializeCampaignDetail(campaign: any, myCompletions: Map<string, any>) {
  return {
    ...serializeCampaignSummary(campaign),
    objective: campaign.objective,
    destinationUrl: campaign.destinationUrl,
    cta: campaign.cta,
    // Banner/Image Promotion and Video Promotion only (meaningless, and
    // always false, for every other type) - true opens destinationUrl/
    // videoUrl in the external browser when a task is tapped; false shows
    // the image/video full-screen in an in-app modal instead. See
    // campaign-detail.page.ts's shouldShowMediaModal.
    openLinkInBrowser: campaign.openLinkInBrowser,
    businessName: campaign.agent?.businessName ?? null,
    // YOUTUBE_SUBSCRIBE only (null everywhere else): the agent's
    // OAuth-verified channel, so the app can name the channel the user is
    // being asked to subscribe to and open the right place. The id is
    // included because it is what the verification actually matches on -
    // showing a name while checking an id would make a mismatch invisible.
    youtubeChannelId: campaign.youtubeChannelId,
    youtubeChannelName: campaign.youtubeChannelName,
    youtubeChannelUrl: campaign.youtubeChannelUrl,
    tasks: (campaign.tasks ?? [])
      .filter((t: any) => t.status === 'ACTIVE')
      .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
      .map((t: any) => {
        const mine = myCompletions.get(t.id) ?? null;
        return {
          id: t.id,
          title: t.title,
          description: t.description,
          type: t.type,
          instructions: t.instructions,
          reward: toMoney(t.rewardAmount),
          isRequired: t.isRequired,
          // Single source of truth is resolveTaskStrategy - the same check
          // submitTask itself makes - so the client never re-derives this
          // from campaign type codes on its own (spec: "centralize the
          // proofRequired condition, don't duplicate it across components").
          requiresProof: resolveTaskStrategy(t) === 'MANUAL',
          // App Promotion only - the promoted app itself confirms completion
          // via POST /app-verification/confirm, so the client shows a
          // "waiting for verification" state instead of a Complete Task
          // button (there is no self-confirmation step for these tasks).
          requiresAppVerification: resolveTaskStrategy(t) === 'APP_DOWNLOAD',
          // Website Promotion only - the client auto-submits once the
          // agent-configured visitDurationSeconds (see `details` below) has
          // elapsed since Start Task, instead of showing a Complete Task
          // button. The required duration itself isn't duplicated into a
          // separate field here - it's already in `details.visitDurationSeconds`
          // like every other per-type configuration value.
          requiresDwellTime: resolveTaskStrategy(t) === 'TIME_ON_SITE',
          // Website Promotion with on-site verification - the reward is
          // credited by the agent's own site calling POST
          // /website-verification/confirm with the one-time token
          // /tasks/:id/start appended to the destination URL, so the client
          // shows a "finish on the website" state and polls, exactly as it
          // already does for requiresAppVerification, instead of running its
          // own countdown and auto-submitting.
          requiresWebsiteToken: resolveTaskStrategy(t) === 'WEBSITE_TOKEN',
          // YouTube Subscribe - the client shows a "subscribe, then verify"
          // state with a Verify Subscription button instead of a Complete
          // Task button, and the reward is credited only by POST
          // /tasks/:taskId/verify-youtube-subscription asking the YouTube API
          // (youtube-verification.service.ts). Same shape as every flag above:
          // derived from the one strategy resolver, never re-derived from
          // campaign type codes on the client.
          requiresYoutubeSubscription: resolveTaskStrategy(t) === 'YOUTUBE_SUBSCRIPTION',
          // Type-specific fields only (campaign-type-fields.ts) - the one
          // internal key sharing this JSON column, verificationStrategy, is
          // a backend concern and never meant for the client.
          details: Object.fromEntries(Object.entries((t.configuration ?? {}) as Record<string, unknown>).filter(([key]) => key !== 'verificationStrategy')),
          // This user's current attempt at this task, if any - lets the
          // client correctly show "Under review" / "Completed" / "Rejected"
          // on page load instead of always starting from a blank IDLE state.
          myCompletion: mine
            ? {
                id: mine.id,
                status: mine.status,
                rewardAmount: mine.rewardAmount != null ? toMoneyString(mine.rewardAmount) : null,
                rejectionReason: mine.rejectionReason,
                startedAt: mine.startedAt,
                // EVERY_TIME only: when checkEveryTimeCooldown
                // (eligibility.service.ts) will let this task start again,
                // so the client can disable "Do It Again" and count down
                // instead of letting a tap during the window round-trip into
                // a 409 it has no context for.
                availableAgainAt:
                  campaign.completionFrequency === 'EVERY_TIME' && mine.status === 'COMPLETED' && mine.completedAt
                    ? new Date(mine.completedAt.getTime() + EVERY_TIME_COOLDOWN_MS)
                    : null,
              }
            : null,
        };
      }),
  };
}

const agentEligibleWhere = (now: Date): Prisma.AgentProfileWhereInput => ({
  status: 'ACTIVE',
  subscriptions: { some: { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } },
});

const activeWhere = (): Prisma.CampaignWhereInput => {
  const now = new Date();
  return {
    status: 'ACTIVE',
    OR: [{ startsAt: null }, { startsAt: { lte: now } }],
    AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
    agent: agentEligibleWhere(now),
  };
};

// User-completed-campaign exclusion (spec §2's "not already completed when
// repeat is not allowed") is applied after the DB page is fetched rather
// than pushed into the WHERE clause - correct for Phase 4's scale, and
// isolated here so it can move into SQL later without touching callers.
//
// Resolved in a fixed number of queries rather than one per campaign. This
// used to await a separate count() inside the loop, so a feed page of 30
// campaigns meant 30 sequential database round trips before a single byte
// could be sent - the dominant cost of the busiest endpoint in the API, and
// the one that multiplied fastest when several people loaded the feed at
// once. currentCycleDate only ever returns 'ONCE' or today's date, so
// batching by cycle key collapses the whole thing into at most two queries
// no matter how many campaigns are in the feed.
//
// The (userId, taskId, cycleDate) uniqueness constraint is what makes
// counting matched task ids identical to the count() this replaces: a task
// can contribute at most one completion row per cycle.
async function excludeFullyCompleted(userId: string, campaigns: any[]) {
  const pending: { campaignId: string; requiredIds: string[]; cycleDate: string }[] = [];
  const taskIdsByCycle = new Map<string, Set<string>>();

  for (const campaign of campaigns) {
    const requiredIds: string[] = campaign.tasks
      .filter((t: any) => t.isRequired && t.status === 'ACTIVE')
      .map((t: any) => t.id);
    // EVERY_TIME never hides for completion at all - resolveStartCycle
    // (eligibility.service.ts) always opens a fresh cycle the instant the
    // user's last attempt finishes, so there's never a "come back later"
    // wait to reflect in the feed the way DAILY has.
    if (requiredIds.length === 0 || campaign.completionFrequency === 'EVERY_TIME') continue;

    // DAILY campaigns only hide for the current cycle - a user who finished
    // one on a previous day is eligible again today (see startTask/
    // checkTaskEligibility, which key off the same cycleDate).
    const cycleDate = currentCycleDate(campaign.completionFrequency);
    pending.push({ campaignId: campaign.id, requiredIds, cycleDate });

    let bucket = taskIdsByCycle.get(cycleDate);
    if (!bucket) {
      bucket = new Set<string>();
      taskIdsByCycle.set(cycleDate, bucket);
    }
    for (const id of requiredIds) bucket.add(id);
  }

  if (pending.length === 0) return campaigns;

  const completedByCycle = new Map<string, Set<string>>();
  await Promise.all(
    [...taskIdsByCycle].map(async ([cycleDate, taskIds]) => {
      const rows = await prisma.userTaskCompletion.findMany({
        where: { userId, taskId: { in: [...taskIds] }, status: 'COMPLETED', cycleDate },
        select: { taskId: true },
      });
      completedByCycle.set(cycleDate, new Set(rows.map((r) => r.taskId)));
    }),
  );

  const fullyCompleted = new Set<string>();
  for (const { campaignId, requiredIds, cycleDate } of pending) {
    const completedIds = completedByCycle.get(cycleDate);
    if (!completedIds) continue;
    if (requiredIds.every((id) => completedIds.has(id))) fullyCompleted.add(campaignId);
  }

  // Filtered rather than rebuilt, so the database's ordering survives - the
  // default feed sort has no JavaScript re-sort behind it to put things back.
  return campaigns.filter((c) => !fullyCompleted.has(c.id));
}

export async function listFeed(userId: string, params: { page: number; pageSize: number; type?: string; sort: string; q?: string }) {
  const where: Prisma.CampaignWhereInput = {
    ...activeWhere(),
    ...(params.type ? { campaignType: { code: params.type } } : {}),
    ...(params.q ? { campaignName: { contains: params.q, mode: 'insensitive' } } : {}),
  };

  const orderBy: Prisma.CampaignOrderByWithRelationInput =
    params.sort === 'newest' ? { createdAt: 'desc' } : { createdAt: 'desc' }; // reward/duration sorts applied below (computed fields)

  const candidates = await prisma.campaign.findMany({
    where,
    include: { campaignType: true, tasks: { where: { status: 'ACTIVE' } } },
    orderBy,
    // Capacity-limited campaigns that are full are excluded here too.
  });

  const withCapacity = candidates.filter((c) => c.completionLimit == null || c.completedCount < c.completionLimit);
  const eligible = await excludeFullyCompleted(userId, withCapacity);

  // Sorted on the raw Decimal/Date fields (Decimal.comparedTo, not `-`) before
  // serializing, since `reward` is a formatted string by the time it's on
  // the summary object and string subtraction would silently misbehave.
  let ordered = eligible;
  if (params.sort === 'reward_desc') {
    ordered = [...eligible].sort((a, b) => totalRewardOf(b).comparedTo(totalRewardOf(a)));
  } else if (params.sort === 'duration_asc') {
    const durationOf = (c: any) => (c.startsAt && c.expiresAt ? c.expiresAt.getTime() - c.startsAt.getTime() : Infinity);
    ordered = [...eligible].sort((a, b) => durationOf(a) - durationOf(b));
  }

  const sorted = ordered.map(serializeCampaignSummary);
  const total = sorted.length;
  const start = (params.page - 1) * params.pageSize;
  const data = sorted.slice(start, start + params.pageSize);

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

// Distinct, spec-mandated wording (§36) for the specific reason a campaign
// isn't available, instead of collapsing every non-ACTIVE state into a
// generic 404 - a campaign a user could see minutes ago failing differently
// from one that never existed is real information for the UI to show.
export async function getFeedDetail(userId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      campaignType: true,
      tasks: true,
      agent: { select: { businessName: true, status: true, subscriptions: { where: { status: 'ACTIVE' }, select: { expiresAt: true } } } },
    },
  });
  if (!campaign) throw Errors.notFound('Campaign');

  const now = new Date();
  const isExpired = campaign.status === 'EXPIRED' || (campaign.expiresAt != null && campaign.expiresAt <= now);
  const isFull = campaign.completionLimit != null && campaign.completedCount >= campaign.completionLimit;
  // Same agent-in-good-standing requirement as the feed's activeWhere() -
  // a suspended agent or a lapsed plan makes an otherwise-ACTIVE campaign
  // unavailable too, not just absent from the list. Treated as a plain 404
  // rather than a distinct conflict reason: unlike CAMPAIGN_EXPIRED/PAUSED,
  // this isn't the campaign's own lifecycle state, so it isn't something
  // the UI should describe to the end user any differently than "gone".
  const agentEligible =
    campaign.agent.status === 'ACTIVE' && campaign.agent.subscriptions.some((s) => s.expiresAt == null || s.expiresAt > now);
  if (!agentEligible) throw Errors.notFound('Campaign');

  if (isExpired) throw Errors.conflict('CAMPAIGN_EXPIRED', 'This campaign has expired.');
  if (campaign.status === 'PAUSED') throw Errors.conflict('CAMPAIGN_PAUSED', 'This campaign is currently paused.');
  if (campaign.status === 'COMPLETED' || isFull) {
    throw Errors.conflict('CAMPAIGN_COMPLETED', 'This campaign has reached its completion limit.');
  }
  if (campaign.status !== 'ACTIVE') throw Errors.notFound('Campaign');
  if (campaign.startsAt != null && campaign.startsAt > now) {
    throw Errors.conflict('CAMPAIGN_NOT_STARTED', 'This campaign has not started yet.');
  }

  const requiredIds = campaign.tasks.filter((t) => t.isRequired && t.status === 'ACTIVE').map((t) => t.id);
  if (requiredIds.length > 0 && campaign.completionFrequency !== 'EVERY_TIME') {
    const cycleDate = currentCycleDate(campaign.completionFrequency);
    const completed = await prisma.userTaskCompletion.count({ where: { userId, taskId: { in: requiredIds }, status: 'COMPLETED', cycleDate } });
    if (completed >= requiredIds.length) {
      // DAILY is a cooldown, not a dead end - saying so is the difference
      // between a user thinking the campaign is over and knowing it comes
      // back tomorrow with the reward payable again.
      const message =
        campaign.completionFrequency === 'DAILY'
          ? 'You have already completed this campaign today. Come back tomorrow to earn it again.'
          : 'You have already completed this campaign.';
      throw Errors.conflict('CAMPAIGN_ALREADY_COMPLETED', message);
    }
  }

  // Fire-and-forget: a view is a best-effort counter, not part of the
  // response the user is waiting on.
  prisma.campaign.update({ where: { id: campaignId }, data: { viewCount: { increment: 1 } } }).catch(() => {});

  const myCompletions = new Map<string, any>();
  await Promise.all(
    campaign.tasks.map(async (t) => {
      const completion = await getMyCompletion(userId, campaign, t.id);
      if (completion) myCompletions.set(t.id, completion);
    }),
  );

  return serializeCampaignDetail(campaign, myCompletions);
}
