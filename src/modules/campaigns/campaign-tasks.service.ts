import { prisma } from '../../db/prisma.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { toMoneyString } from '../../utils/money.js';
import { validateSurveyQuestions, validateTypeMetadata } from './campaign-type-fields.js';

// Single source of truth for "this campaign type requires a proof-upload +
// Admin-review cycle instead of a plain self-confirmation". Every other
// call site (the user feed serializer, task eligibility, submitTask) reads
// the MANUAL strategy this stamps onto the task's own `configuration`
// rather than re-checking campaign type codes itself - this is the only
// place that mapping is decided, and it is enforced server-side regardless
// of what the client sends, exactly as the reward amount already is.
// YOUTUBE_PROMOTION is proof-required in full (every requiredAction, not
// just Subscribe) - it is the type an agent uses for any channel, including
// one they cannot prove they own, so a screenshot plus admin review is the
// strongest check available to it. The separate, OAuth-verified
// YOUTUBE_SUBSCRIBE type below is not in this set: it has a real check and
// deliberately never asks for a screenshot.
const PROOF_REQUIRED_CAMPAIGN_TYPES = new Set(['YOUTUBE_PROMOTION', 'INSTAGRAM_FOLLOW', 'FACEBOOK_PAGE_LIKE']);

// App Promotion tasks are verified by the promoted app itself calling back
// POST /app-verification/confirm with a matching device Advertising ID
// (app-verification.service.ts), not by a self-confirmation click or an
// admin-reviewed screenshot - APP_DOWNLOAD is the strategy name
// verification.service.ts already reserved for exactly this integration.
const APP_INSTALL_VERIFIED_CAMPAIGN_TYPES = new Set(['APP_PROMOTION']);

// Website Promotion (agent-configured duration), Banner/Image Promotion
// (fixed duration) and Video Promotion (agent-configured watch duration - see
// below) all require the user to stay engaged for visitDurationSeconds before
// a submit is allowed to pass - see verification.service.ts's TIME_ON_SITE
// strategy, which reads that same configuration key back out at submit time.
const DWELL_TIME_VERIFIED_CAMPAIGN_TYPES = new Set(['WEBSITE_PROMOTION', 'BANNER_IMAGE', 'VIDEO']);

// Website Promotion, and only when the owning agent switched on
// Campaign.websiteVerificationEnabled: the in-app countdown is replaced by a
// real signal from the promoted site itself. The Ionic app appends a
// one-time token to the destination URL, the site runs its own timer and
// shows a reward button, and clicking it calls POST
// /website-verification/confirm - which is the only thing that can credit
// one of these (website-verification.service.ts). The dwell requirement
// isn't dropped, just moved: the same visitDurationSeconds is re-checked
// server-side against the completion's startedAt when that callback lands,
// so the site's own timer is a UX nicety, never the guarantee.
const WEBSITE_TOKEN_VERIFIED_CAMPAIGN_TYPES = new Set(['WEBSITE_PROMOTION']);

// YouTube Subscribe, verified for real: the user's own Google grant is asked
// whether they are subscribed to the campaign's OAuth-verified channel
// (youtube-verification.service.ts). Deliberately a SEPARATE campaign type
// from YOUTUBE_PROMOTION rather than an upgrade of it - YOUTUBE_PROMOTION
// stays exactly as it is (screenshot proof + admin review, and an
// agent-typed channel URL), because a campaign that can only exist against a
// channel the agent has proven they own is a different product, not a
// different setting. Every YOUTUBE_PROMOTION campaign already running is
// untouched by this.
const YOUTUBE_OAUTH_VERIFIED_CAMPAIGN_TYPES = new Set(['YOUTUBE_SUBSCRIBE']);

// Banner/Image Promotion and Video Promotion have no agent-facing duration
// field (unlike Website Promotion's visitDurationSeconds select) - the
// required 30s is fixed and stamped here rather than collected from the
// create form.
const FIXED_DWELL_SECONDS = '30';

// Validates the type-specific fields (campaign-type-fields.ts) against
// whatever the client sent, dropping anything not in that type's registry,
// then stamps verificationStrategy on top - one JSON blob for both concerns
// since they already share the same Task.configuration column. SURVEY's
// `questions` array is validated the same way but kept as a distinct,
// explicitly-typed input (TaskInput.questions) rather than just another
// key in the free-form `configuration` bag, since it's structured data
// with its own validation, not a flat scalar.
// `requireQuestions` is true only from createTask - a SURVEY task cannot be
// created without at least one question, but a later updateTask call that
// isn't touching questions at all (e.g. just editing the title) must not
// be forced to resend the whole question list.
// The one place a campaign type (plus, for Website Promotion, its
// on-site-verification toggle) is turned into a verification strategy.
// Undefined means "no special strategy" - verification.service.ts's
// resolveStrategy then falls back to USER_CONFIRMATION, which is exactly
// what an unstamped task should do.
function verificationStrategyFor(campaignTypeCode: string, websiteVerificationEnabled: boolean): string | undefined {
  if (YOUTUBE_OAUTH_VERIFIED_CAMPAIGN_TYPES.has(campaignTypeCode)) return 'YOUTUBE_SUBSCRIPTION';
  if (PROOF_REQUIRED_CAMPAIGN_TYPES.has(campaignTypeCode)) return 'MANUAL';
  if (APP_INSTALL_VERIFIED_CAMPAIGN_TYPES.has(campaignTypeCode)) return 'APP_DOWNLOAD';
  if (websiteVerificationEnabled && WEBSITE_TOKEN_VERIFIED_CAMPAIGN_TYPES.has(campaignTypeCode)) return 'WEBSITE_TOKEN';
  if (DWELL_TIME_VERIFIED_CAMPAIGN_TYPES.has(campaignTypeCode)) return 'TIME_ON_SITE';
  return undefined;
}

function resolveTaskConfiguration(
  campaignTypeCode: string,
  input: TaskInput | Partial<TaskInput>,
  requireQuestions: boolean,
  websiteVerificationEnabled = false,
): Prisma.InputJsonValue {
  const configuration = validateTypeMetadata(campaignTypeCode, input.configuration);
  const strategy = verificationStrategyFor(campaignTypeCode, websiteVerificationEnabled);
  if (strategy) {
    configuration['verificationStrategy'] = strategy;
    if (strategy === 'TIME_ON_SITE' && (campaignTypeCode === 'BANNER_IMAGE' || campaignTypeCode === 'VIDEO')) {
      configuration['visitDurationSeconds'] = FIXED_DWELL_SECONDS;
    }
  }
  if (campaignTypeCode === 'SURVEY' && (requireQuestions || input.questions !== undefined)) {
    configuration['questions'] = validateSurveyQuestions(input.questions);
  }
  return configuration as Prisma.InputJsonValue;
}

// Re-applies just the verificationStrategy key to a campaign's existing
// tasks after something outside the task itself changed which strategy it
// should be running - today, an agent flipping Website Promotion's on-site
// verification toggle after the task was already created. Deliberately a
// targeted rewrite of one key rather than a full resolveTaskConfiguration
// pass: re-validating a task that is already persisted could throw on data
// the agent isn't editing right now, and the only thing that actually needs
// to change here is the strategy.
export async function restampTaskVerificationStrategies(campaignId: string, campaignTypeCode: string, websiteVerificationEnabled: boolean) {
  const strategy = verificationStrategyFor(campaignTypeCode, websiteVerificationEnabled);
  const tasks = await prisma.task.findMany({ where: { campaignId } });

  for (const task of tasks) {
    const configuration = { ...((task.configuration ?? {}) as Record<string, unknown>) };
    if (configuration['verificationStrategy'] === strategy) continue;

    // Removed rather than left behind when the new type has no strategy of
    // its own: a stale WEBSITE_TOKEN on a campaign that is no longer a
    // token-verified Website Promotion would be unusable in both directions
    // - the in-app submit refuses it, and the website callback has no key to
    // authenticate with.
    if (strategy) configuration['verificationStrategy'] = strategy;
    else delete configuration['verificationStrategy'];

    await prisma.task.update({ where: { id: task.id }, data: { configuration: configuration as Prisma.InputJsonValue } });
  }
}

async function ownedDraftCampaignOrThrow(agentId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { campaignType: true } });
  if (!campaign || campaign.agentId !== agentId) throw Errors.notFound('Campaign');
  if (campaign.status !== 'DRAFT') throw Errors.conflict('NOT_EDITABLE', 'Tasks can only be edited while the campaign is a draft.');
  return campaign;
}

// No `rewardAmount` here - the User reward is no longer agent-entered
// (Phase 5 update §1/§6). It's always derived from the campaign's type.
export interface TaskInput {
  title: string;
  description?: string;
  type: string;
  instructions?: string;
  sortOrder?: number;
  isRequired?: boolean;
  configuration?: Record<string, unknown>;
  // SURVEY only - validated by validateSurveyQuestions and merged into
  // configuration.questions.
  questions?: unknown[];
}

export function listTasks(campaignId: string) {
  return prisma.task.findMany({ where: { campaignId }, orderBy: { sortOrder: 'asc' } });
}

export async function createTask(agentId: string, campaignId: string, input: TaskInput) {
  const campaign = await ownedDraftCampaignOrThrow(agentId, campaignId);
  const task = await prisma.task.create({
    data: {
      campaignId,
      title: input.title,
      description: input.description,
      type: input.type,
      instructions: input.instructions,
      // Stamped from the Admin-configured reward for this campaign's type at
      // the moment of creation, never from client input - immutable from
      // here on even if Admin later changes the type's configured reward
      // (spec Phase 5 update §10/§16).
      rewardAmount: campaign.campaignType.rewardAmount,
      sortOrder: input.sortOrder ?? 0,
      isRequired: input.isRequired ?? true,
      configuration: resolveTaskConfiguration(campaign.campaignType.code, input, true, campaign.websiteVerificationEnabled),
    },
  });

  await writeAuditLog({
    action: 'TASK_REWARD_SET',
    entityType: 'tasks',
    entityId: task.id,
    metadata: { campaignId, campaignType: campaign.campaignType.code, rewardAmount: toMoneyString(task.rewardAmount) },
  });

  return task;
}

export async function updateTask(agentId: string, campaignId: string, taskId: string, input: Partial<TaskInput>) {
  const campaign = await ownedDraftCampaignOrThrow(agentId, campaignId);
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.campaignId !== campaignId) throw Errors.notFound('Task');

  // Re-derived on every save, not just at creation - if Admin changed this
  // type's reward since the task was first added, a still-DRAFT (i.e. not
  // yet immutable) task picks up the current configuration rather than a
  // stale one (spec Phase 5 update §14).
  const newRewardAmount = campaign.campaignType.rewardAmount;
  const oldRewardAmount = task.rewardAmount;
  const rewardChanged = !oldRewardAmount.equals(newRewardAmount);

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: {
      title: input.title,
      description: input.description,
      type: input.type,
      instructions: input.instructions,
      rewardAmount: newRewardAmount,
      sortOrder: input.sortOrder,
      isRequired: input.isRequired,
      configuration:
        input.configuration !== undefined || input.questions !== undefined
          ? resolveTaskConfiguration(campaign.campaignType.code, input, false, campaign.websiteVerificationEnabled)
          : undefined,
    },
  });

  if (rewardChanged) {
    await writeAuditLog({
      action: 'TASK_REWARD_CHANGED',
      entityType: 'tasks',
      entityId: updated.id,
      metadata: {
        campaignId,
        oldRewardAmount: toMoneyString(oldRewardAmount),
        newRewardAmount: toMoneyString(updated.rewardAmount),
      },
    });
  }

  return updated;
}

export async function removeTask(agentId: string, campaignId: string, taskId: string) {
  await ownedDraftCampaignOrThrow(agentId, campaignId);
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.campaignId !== campaignId) throw Errors.notFound('Task');
  await prisma.task.delete({ where: { id: taskId } });
}
