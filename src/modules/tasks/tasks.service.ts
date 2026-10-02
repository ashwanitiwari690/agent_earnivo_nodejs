import { prisma } from '../../db/prisma.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { Errors } from '../../utils/AppError.js';
import { checkCampaignEligibility, checkEveryTimeCooldown, checkTaskEligibility, resolveStartCycle } from './eligibility.service.js';
import { resolveTaskStrategy, verifyTaskCompletion } from './verification.service.js';
import { creditReward } from './reward.service.js';
import { toMoneyString } from '../../utils/money.js';
import { createNotification, notifyAdmins } from '../notifications/notifications.service.js';
import { generateVerificationToken } from '../../utils/apiKey.js';
import { buildVerificationUrl } from '../website-verification/website-verification.service.js';
import { findConnection } from '../google-oauth/google-oauth.service.js';
import { ensureVerificationRecord } from '../youtube-verification/youtube-verification.service.js';

// How long a Website Promotion verification token stays usable. Long enough
// that a user who opens the site, gets distracted and comes back later still
// gets credited, short enough that a token leaked out of a browser history
// or a shared link isn't usable indefinitely. The token is bound to one
// completion either way, so the worst an expired-but-stolen one could ever
// do is credit the user it already belonged to.
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Mints (or refreshes) the one-time credential a WEBSITE_TOKEN completion
// hands to the promoted website, and returns it alongside the destination
// URL it should be appended to. Refreshed rather than reused blindly on a
// resumed attempt: a user who started this task yesterday and is only now
// opening the site would otherwise carry an already-expired token to a page
// that can do nothing but reject it.
async function issueVerificationToken(completionId: string, destinationUrl: string | null, existingToken?: { verificationToken: string | null; verificationTokenExpiresAt: Date | null }) {
  const stillValid =
    existingToken?.verificationToken && existingToken.verificationTokenExpiresAt && existingToken.verificationTokenExpiresAt > new Date();

  const verificationToken = stillValid
    ? existingToken!.verificationToken!
    : (
        await prisma.userTaskCompletion.update({
          where: { id: completionId },
          data: { verificationToken: generateVerificationToken(), verificationTokenExpiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS) },
        })
      ).verificationToken!;

  return { verificationToken, verificationUrl: buildVerificationUrl(destinationUrl, verificationToken) };
}

async function loadTaskAndCampaign(taskId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { campaign: true } });
  if (!task) throw Errors.notFound('Task');
  return task;
}

function assertCampaignIsOpen(campaign: { status: string; startsAt: Date | null; expiresAt: Date | null }) {
  const now = new Date();
  if (campaign.status !== 'ACTIVE') {
    throw Errors.conflict('CAMPAIGN_NOT_ACTIVE', 'This campaign is not currently active.');
  }
  if (campaign.startsAt && campaign.startsAt > now) {
    throw Errors.conflict('CAMPAIGN_NOT_STARTED', 'This campaign has not started yet.');
  }
  if (campaign.expiresAt && campaign.expiresAt < now) {
    throw Errors.conflict('CAMPAIGN_EXPIRED', 'This campaign has expired.');
  }
}

export async function startTask(userId: string, taskId: string, advertisingId?: string) {
  const task = await loadTaskAndCampaign(taskId);
  if (task.status !== 'ACTIVE') throw Errors.conflict('TASK_INACTIVE', 'This task is not available.');
  assertCampaignIsOpen(task.campaign);

  const campaignEligibility = await checkCampaignEligibility(userId, task.campaignId);
  if (!campaignEligibility.eligible) throw Errors.forbidden(campaignEligibility.reason);

  // Enforced here rather than left to checkTaskEligibility: EVERY_TIME opens
  // a brand-new cycle the moment the prior one is terminal (resolveStartCycle
  // below), so by the time that check runs against the new cycle it would
  // always find it empty and eligible. This is the one place that still sees
  // the just-finished attempt.
  if (task.campaign.completionFrequency === 'EVERY_TIME') {
    const cooldown = await checkEveryTimeCooldown(userId, taskId);
    if (!cooldown.eligible) throw Errors.conflict('TASK_COOLDOWN_ACTIVE', cooldown.reason ?? 'This task is on cooldown.');
  }

  const cycleDate = await resolveStartCycle(userId, taskId, task.campaign.completionFrequency, task);
  const taskEligibility = await checkTaskEligibility(userId, taskId, cycleDate);
  if (!taskEligibility.eligible) throw Errors.conflict('TASK_ALREADY_COMPLETED', taskEligibility.reason ?? 'Task has already been completed.');

  const strategy = resolveTaskStrategy(task);

  // YouTube Subscribe is the one strategy that cannot work at all without a
  // prior authorization, so it is refused here rather than at verify time:
  // sending someone off to YouTube to subscribe and only then telling them
  // the reward can never be checked would waste the one action the whole
  // task consists of. The Ionic app reads this code and routes them to the
  // connect screen first (spec §7/§20).
  if (strategy === 'YOUTUBE_SUBSCRIPTION') {
    const connection = await findConnection('USER', userId);
    // Two distinct situations, and the client shows different wording for
    // each: never connected (or disconnected by choice) versus connected but
    // no longer usable. Collapsing them into one code would tell someone who
    // has an expired grant to "connect an account" they can see is already
    // connected on their profile.
    if (!connection || connection.status === 'DISCONNECTED') {
      throw Errors.conflict(
        'GOOGLE_ACCOUNT_NOT_CONNECTED',
        'Connect your Google account before starting a YouTube subscribe task, so your subscription can be verified.',
      );
    }
    if (connection.status !== 'CONNECTED') {
      throw Errors.googleReauthRequired();
    }
    if (!task.campaign.youtubeChannelId) {
      throw Errors.conflict('CAMPAIGN_CHANNEL_MISSING', 'This campaign has no verified YouTube channel and cannot be started.');
    }
  }

  const existing = await prisma.userTaskCompletion.findUnique({ where: { userId_taskId_cycleDate: { userId, taskId, cycleDate } } });
  if (existing) {
    // Resume an in-progress attempt rather than erroring - the unique
    // constraint means there can only ever be one row per user+task+cycle.
    const resumed = strategy === 'WEBSITE_TOKEN' ? await issueVerificationToken(existing.id, task.campaign.destinationUrl, existing) : undefined;
    if (strategy === 'YOUTUBE_SUBSCRIPTION') {
      // Idempotent, and deliberately also run on the resume path: an attempt
      // started before this table existed still gets its audit row the first
      // time the user comes back to it.
      await ensureVerificationRecord({
        completionId: existing.id,
        userId,
        campaignId: task.campaignId,
        taskId,
        youtubeChannelId: task.campaign.youtubeChannelId!,
      });
    }
    return { completionId: existing.id, taskId, status: existing.status, ...youtubeChannelOf(task.campaign, strategy), ...resumed };
  }

  // APP_DOWNLOAD (App Promotion) only: this device's OS Advertising ID is
  // what app-verification.service.ts later matches against when the
  // promoted app calls back - see UserTaskCompletion.advertisingId.
  const isAppDownload = strategy === 'APP_DOWNLOAD';
  const completion = await prisma.userTaskCompletion.create({
    data: { userId, campaignId: task.campaignId, taskId, cycleDate, status: 'STARTED', advertisingId: isAppDownload ? advertisingId : undefined },
  });

  // "Click" analytics (spec Phase 8 §5/§6): this is the exact moment the
  // Ionic client opens the external task URL, so it's the one server-side
  // signal that reliably represents click-through intent without needing a
  // separate, unguarded "track click" endpoint.
  await prisma.campaign.update({ where: { id: task.campaignId }, data: { clickCount: { increment: 1 } } });

  // WEBSITE_TOKEN (Website Promotion with on-site verification) only: the
  // client opens `verificationUrl` instead of the bare destination URL, so
  // the promoted site receives the credential that lets it call back and
  // credit this exact attempt.
  const issued = strategy === 'WEBSITE_TOKEN' ? await issueVerificationToken(completion.id, task.campaign.destinationUrl) : undefined;

  // YOUTUBE_SUBSCRIPTION only: the attempt's own audit row, stamped with the
  // channel it will be checked against, so a later "which channel was this
  // actually verified for" question has an answer that no later campaign
  // edit can rewrite (youtube-verification.service.ts).
  if (strategy === 'YOUTUBE_SUBSCRIPTION') {
    await ensureVerificationRecord({
      completionId: completion.id,
      userId,
      campaignId: task.campaignId,
      taskId,
      youtubeChannelId: task.campaign.youtubeChannelId!,
    });
  }

  return { completionId: completion.id, taskId, status: completion.status, ...youtubeChannelOf(task.campaign, strategy), ...issued };
}

// The channel the client should open, handed back explicitly rather than
// leaving the app to infer it from destinationUrl. Same intent as
// issueVerificationToken's verificationUrl: the endpoint that starts the
// attempt is also the one that says where to send the user.
function youtubeChannelOf(campaign: { youtubeChannelId: string | null; youtubeChannelName: string | null; youtubeChannelUrl: string | null; destinationUrl: string | null }, strategy: string) {
  if (strategy !== 'YOUTUBE_SUBSCRIPTION' || !campaign.youtubeChannelId) return undefined;
  return {
    youtubeChannelId: campaign.youtubeChannelId,
    youtubeChannelName: campaign.youtubeChannelName,
    youtubeChannelUrl: campaign.youtubeChannelUrl ?? campaign.destinationUrl,
  };
}

// Lightweight poll target for the Ionic client while a task is awaiting
// asynchronous verification (currently: APP_DOWNLOAD's app-install
// callback) - deliberately not startTask, which re-opens the external URL
// as a side effect and would be wrong to call repeatedly just to check status.
export async function getCompletionStatus(userId: string, completionId: string) {
  const completion = await prisma.userTaskCompletion.findUnique({ where: { id: completionId } });
  if (!completion || completion.userId !== userId) throw Errors.notFound('Task completion');

  const wallet = completion.status === 'COMPLETED' ? await prisma.userWallet.findUnique({ where: { userId } }) : null;
  return {
    id: completion.id,
    status: completion.status,
    rewardAmount: completion.rewardAmount != null ? toMoneyString(completion.rewardAmount) : null,
    newBalance: wallet ? toMoneyString(wallet.balance) : undefined,
  };
}

export async function submitTask(userId: string, completionId: string, submissionData: Record<string, unknown>) {
  const completion = await prisma.userTaskCompletion.findUnique({
    where: { id: completionId },
    include: { task: { include: { campaign: true } } },
  });
  if (!completion || completion.userId !== userId) throw Errors.notFound('Task completion');

  // Idempotent: calling submit again on an already-finished (or
  // already-under-review) completion just returns the existing outcome
  // instead of re-running verification/reward.
  if (completion.status === 'COMPLETED' || completion.status === 'APPROVED' || completion.status === 'PENDING') {
    const wallet = await prisma.userWallet.findUnique({ where: { userId } });
    return {
      completionId: completion.id,
      status: completion.status,
      rewardAmount: completion.rewardAmount != null ? toMoneyString(completion.rewardAmount) : null,
      newBalance: wallet ? toMoneyString(wallet.balance) : undefined,
      alreadyCompleted: true,
    };
  }

  const strategy = resolveTaskStrategy(completion.task);

  // Checked before anything mutates this completion: a WEBSITE_TOKEN task is
  // credited exclusively by the promoted site's own callback
  // (website-verification.service.ts), so an in-app submit must leave the
  // attempt untouched and still STARTED - running it through verification
  // would stamp it REJECTED and lock out the very callback that is supposed
  // to complete it.
  if (strategy === 'WEBSITE_TOKEN') {
    throw Errors.conflict(
      'WEBSITE_VERIFICATION_REQUIRED',
      "This task is verified on the advertiser's website - open the site and use the reward button there once the timer finishes.",
    );
  }

  // Same reasoning for YouTube Subscribe: the only thing that may credit one
  // of these is POST /tasks/:taskId/verify-youtube-subscription, which asks
  // YouTube itself. Letting a submit through would stamp the attempt REJECTED
  // and lock out the very check that is supposed to complete it, and a
  // self-confirmation click is precisely what this campaign type exists to
  // stop being sufficient (spec §22).
  if (strategy === 'YOUTUBE_SUBSCRIPTION') {
    throw Errors.conflict(
      'YOUTUBE_VERIFICATION_REQUIRED',
      'This task is verified through YouTube - subscribe to the channel, then tap Verify Subscription.',
    );
  }

  if (completion.status === 'REJECTED') {
    // MANUAL (proof/admin-review) and TIME_ON_SITE (Website Promotion dwell
    // check) tasks may retry after rejection - MANUAL needs fresh proof
    // first, TIME_ON_SITE just needs to wait out the remaining time (it
    // re-checks the same original startedAt, so retrying too soon just
    // fails again). Every other strategy keeps its original one-shot rule.
    if (strategy !== 'MANUAL' && strategy !== 'TIME_ON_SITE') {
      throw Errors.conflict('TASK_ALREADY_REJECTED', 'This task submission was already rejected.');
    }
    if (strategy === 'MANUAL' && !completion.proofImageUrl) {
      throw Errors.validation('Please upload new proof before resubmitting this task.');
    }
  }

  // Re-checked here, not just at /start: a task can be started while a
  // campaign is open and submitted after it expires/pauses/ends, so the
  // reward-crediting path needs its own gate rather than trusting whatever
  // was true when the completion row was created (spec §13/TEST 8).
  assertCampaignIsOpen(completion.task.campaign);

  await prisma.userTaskCompletion.update({
    where: { id: completionId },
    data: { status: 'SUBMITTED', submittedAt: new Date(), verificationData: submissionData as Prisma.InputJsonValue },
  });

  const verification = verifyTaskCompletion(completion.task, submissionData, {
    proofImageUrl: completion.proofImageUrl,
    startedAt: completion.startedAt,
    requiredDwellSeconds: Number((completion.task.configuration as Record<string, unknown> | null)?.['visitDurationSeconds']) || undefined,
  });

  if (verification.status === 'FAILED') {
    const rejected = await prisma.userTaskCompletion.update({
      where: { id: completionId },
      data: { status: 'REJECTED', verificationStatus: 'FAILED', rejectionReason: verification.reason },
    });
    return { completionId: rejected.id, status: rejected.status, rejectionReason: rejected.rejectionReason };
  }

  if (verification.status === 'PENDING') {
    // Proof received - hand off to Admin review instead of crediting.
    // Clearing any prior rejection info here matters for the resubmit
    // path: a user retrying after a REJECTED verdict should not still see
    // the old reason once a new review is underway.
    const pending = await prisma.userTaskCompletion.update({
      where: { id: completionId },
      data: { status: 'PENDING', verificationStatus: 'PENDING', rejectionReason: null, reviewedBy: null, reviewedAt: null },
    });
    await notifyAdmins({
      type: 'TASK_PROOF_SUBMITTED',
      title: 'New task proof awaiting review',
      message: `A user submitted proof for "${completion.task.title}".`,
      metadata: { completionId, taskId: completion.taskId, campaignId: completion.campaignId },
    });
    return { completionId: pending.id, status: pending.status, rewardAmount: null, newBalance: undefined, alreadyCompleted: false };
  }

  await prisma.userTaskCompletion.update({ where: { id: completionId }, data: { status: 'APPROVED', verificationStatus: 'PASSED' } });

  const result = await creditReward(completionId);
  const final = await prisma.userTaskCompletion.findUniqueOrThrow({ where: { id: completionId } });
  const newBalance = result.newBalance ?? (await prisma.userWallet.findUnique({ where: { userId } }))?.balance;

  if (result.credited && final.rewardAmount != null) {
    await createNotification({
      userId,
      type: 'REWARD_CREDITED',
      title: 'Reward credited',
      message: `You earned ₹${toMoneyString(final.rewardAmount)} for "${completion.task.title}".`,
      metadata: { completionId, taskId: completion.taskId, campaignId: completion.campaignId },
    });
  }

  return {
    completionId: final.id,
    status: final.status,
    rewardAmount: final.rewardAmount != null ? toMoneyString(final.rewardAmount) : null,
    newBalance: newBalance != null ? toMoneyString(newBalance) : undefined,
    alreadyCompleted: result.alreadyCredited ?? false,
  };
}

// Only meaningful for MANUAL-strategy tasks (the proof/admin-review social
// campaigns) - backend-verified, not trusted from a client-sent flag, so a
// user can't attach a "proof" to a task that never required one, and can't
// swap in a new image once the completion has moved past review (PENDING/
// APPROVED/COMPLETED) or been credited.
export async function uploadTaskProof(userId: string, completionId: string, proofImageUrl: string) {
  const completion = await prisma.userTaskCompletion.findUnique({
    where: { id: completionId },
    include: { task: true },
  });
  if (!completion || completion.userId !== userId) throw Errors.notFound('Task completion');

  if (resolveTaskStrategy(completion.task) !== 'MANUAL') {
    throw Errors.validation('This task does not require proof.');
  }
  if (!['STARTED', 'SUBMITTED', 'REJECTED'].includes(completion.status)) {
    throw Errors.conflict('PROOF_NOT_ACCEPTED', 'Proof can no longer be uploaded for this task.');
  }

  const updated = await prisma.userTaskCompletion.update({
    where: { id: completionId },
    data: {
      proofImageUrl,
      // A fresh upload after a rejection re-opens the attempt for submit -
      // otherwise submitTask's REJECTED branch would still see the old,
      // already-rejected state.
      ...(completion.status === 'REJECTED' ? { status: 'STARTED', rejectionReason: null, reviewedBy: null, reviewedAt: null } : {}),
    },
  });

  return { completionId: updated.id, proofImageUrl: updated.proofImageUrl, status: updated.status };
}
