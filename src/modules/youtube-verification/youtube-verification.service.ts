import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { toMoneyString } from '../../utils/money.js';
import { creditReward } from '../tasks/reward.service.js';
import { resolveTaskStrategy } from '../tasks/verification.service.js';
import { findCurrentCompletion } from '../tasks/eligibility.service.js';
import { createNotification } from '../notifications/notifications.service.js';
import { findConnection, getValidAccessToken } from '../google-oauth/google-oauth.service.js';
import { isSubscribedToChannel } from '../youtube/youtube.service.js';

// The status the client sees while an attempt is neither credited nor
// abandoned. Deliberately NOT a new TaskCompletionStatus: the completion row
// stays STARTED (which is what makes a retry legal - see
// checkTaskEligibility), and this is the vocabulary the API speaks on top of
// it. Inventing a database status would have meant teaching every existing
// eligibility/feed/admin path about a state that behaves identically to
// STARTED in all of them.
export const WAITING = 'WAITING_FOR_VERIFICATION';

export interface VerifySubscriptionResult {
  verified: boolean;
  status: 'COMPLETED' | typeof WAITING;
  rewardAmount?: string | null;
  newBalance?: string;
  message?: string;
  alreadyCompleted?: boolean;
}

// Kept identical between the "not subscribed" and "subscribed as a different
// Google account" cases on purpose: from the YouTube API's point of view they
// ARE the same answer (this authenticated account has no subscription to that
// channel), and the wording has to help the far more common real cause -
// someone subscribed while YouTube was signed into their other account (spec
// §13). Claiming to distinguish the two would be inventing certainty this
// check does not have.
const NOT_SUBSCRIBED_MESSAGE =
  'Subscription not found for the Google account connected to Earnivo. Please make sure YouTube is signed in to the same Google account, subscribe, then try again.';

// Ensures the audit row exists for an attempt. Called from /start so a
// support question about an attempt that was never verified still has
// something to look at, and again (idempotently) from verify, so an attempt
// begun before this table existed does not fail to be recorded.
export async function ensureVerificationRecord(input: {
  completionId: string;
  userId: string;
  campaignId: string;
  taskId: string;
  youtubeChannelId: string;
}) {
  return prisma.youTubeTaskVerification.upsert({
    where: { completionId: input.completionId },
    update: {},
    create: { ...input, status: 'WAITING_FOR_VERIFICATION', verificationMethod: 'YOUTUBE_OAUTH' },
  });
}

// Resolves the (task, campaign, completion, connection) tuple a verification
// needs, rejecting every way the request could be wrong before a single
// YouTube quota unit is spent. Order matters: ownership and campaign type are
// checked before the Google connection, so a user poking at someone else's
// task never learns whether that task even exists.
async function loadAttempt(userId: string, taskId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { campaign: { include: { campaignType: true } } } });
  if (!task) throw Errors.notFound('Task');

  if (resolveTaskStrategy(task) !== 'YOUTUBE_SUBSCRIPTION') {
    throw Errors.validation('This task is not a YouTube subscription task.');
  }

  const channelId = task.campaign.youtubeChannelId;
  if (!channelId) {
    // Only reachable for a campaign whose target channel was somehow never
    // stamped - createDraft refuses to create one of these without a verified
    // channel, so this is a fail-closed guard rather than an expected path.
    throw Errors.conflict('CAMPAIGN_CHANNEL_MISSING', 'This campaign has no verified YouTube channel and cannot be completed.');
  }

  const completion = await findCurrentCompletion(userId, taskId, task.campaign.completionFrequency);
  // The ownership check spec §9.3 asks for: findCurrentCompletion is already
  // scoped to this userId, so a completion belonging to anyone else can never
  // be returned here - there is no row to act on rather than someone else's.
  if (!completion) {
    throw Errors.conflict('TASK_NOT_STARTED', 'Start this task before verifying your subscription.');
  }

  return { task, campaign: task.campaign, channelId, completion };
}

// POST /api/tasks/:taskId/verify-youtube-subscription
//
// The one place a YOUTUBE_SUBSCRIBE reward is decided. The check is always
// "the USER's own OAuth grant, asked about the AGENT's verified channel id"
// (spec §10) - the agent's token is never involved, and no subscriber list is
// ever scanned.
export async function verifySubscription(userId: string, taskId: string): Promise<VerifySubscriptionResult> {
  const { task, campaign, channelId, completion } = await loadAttempt(userId, taskId);

  // Idempotency, checked before anything else can spend quota or touch a
  // wallet (spec §14). creditReward is independently guarded against a double
  // credit, so this is the fast path rather than the guarantee: a client that
  // retries a verify call after the reward landed gets the same answer back
  // instead of an error suggesting something went wrong.
  if (completion.status === 'COMPLETED' || completion.status === 'APPROVED') {
    const wallet = await prisma.userWallet.findUnique({ where: { userId } });
    return {
      verified: true,
      status: 'COMPLETED',
      rewardAmount: completion.rewardAmount != null ? toMoneyString(completion.rewardAmount) : null,
      newBalance: wallet ? toMoneyString(wallet.balance) : undefined,
      alreadyCompleted: true,
    };
  }

  // Re-checked at verification time, not just at /start: a task can be
  // started while a campaign is open and verified after it expires or is
  // paused, and this is the call that moves money - the same reasoning
  // submitTask applies for every other strategy (spec §13/TEST 8).
  assertCampaignIsOpen(campaign);

  const verification = await ensureVerificationRecord({
    completionId: completion.id,
    userId,
    campaignId: completion.campaignId,
    taskId,
    youtubeChannelId: channelId,
  });

  const connection = await findConnection('USER', userId);
  if (!connection || connection.status === 'DISCONNECTED') {
    await recordAttempt(verification.id, 'google account not connected');
    throw Errors.conflict(
      'GOOGLE_ACCOUNT_NOT_CONNECTED',
      'Connect your Google account in Earnivo before verifying a YouTube subscription.',
    );
  }

  // Refreshes an expired access token from the stored refresh token, and
  // raises GOOGLE_REAUTH_REQUIRED if the grant is gone (spec §16). Both
  // outcomes are recorded on the attempt before the error leaves this
  // function, so "why did this keep failing" is answerable afterwards.
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(connection);
  } catch (err) {
    await recordAttempt(verification.id, reasonFor(err, 'could not obtain a Google access token'));
    throw err;
  }

  let subscribed: boolean;
  try {
    subscribed = await isSubscribedToChannel(accessToken, channelId);
  } catch (err) {
    await recordAttempt(verification.id, reasonFor(err, 'youtube api error'));
    throw err;
  }

  if (!subscribed) {
    // Never a permanent failure (spec §12): the attempt stays exactly where
    // it was, so the user can subscribe (or switch YouTube to the right
    // account) and press Verify again.
    await recordAttempt(verification.id, 'subscription not found');
    return { verified: false, status: WAITING, message: NOT_SUBSCRIBED_MESSAGE };
  }

  // Verified. Everything from here is the project's existing reward path,
  // untouched: creditReward is the only thing that ever moves a wallet, and
  // its guarded update plus the unique(referenceType, referenceId) index on
  // wallet_transactions are what make a duplicate credit impossible even
  // under two concurrent verify calls.
  await prisma.userTaskCompletion.update({
    where: { id: completion.id },
    data: {
      status: 'APPROVED',
      submittedAt: completion.submittedAt ?? new Date(),
      verificationStatus: 'PASSED',
      // The evidence for this decision, kept on the completion where every
      // existing admin/support view already looks. No token, no API payload -
      // just what was checked and against which channel.
      verificationData: { method: 'YOUTUBE_OAUTH', youtubeChannelId: channelId, googleAccountId: connection.googleAccountId },
    },
  });

  const result = await creditReward(completion.id);
  const final = await prisma.userTaskCompletion.findUniqueOrThrow({ where: { id: completion.id } });
  const newBalance = result.newBalance ?? (await prisma.userWallet.findUnique({ where: { userId } }))?.balance;

  await prisma.youTubeTaskVerification.update({
    where: { id: verification.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      attemptCount: { increment: 1 },
      lastVerificationAttemptAt: new Date(),
      lastFailureReason: null,
    },
  });

  // Only on a credit that actually happened - a repeat verify of an
  // already-credited attempt reaches the idempotent branch above and never
  // gets here, so nobody is told twice that they earned the same reward.
  if (result.credited && final.rewardAmount != null) {
    await createNotification({
      userId,
      type: 'REWARD_CREDITED',
      title: 'YouTube subscription verified',
      message: `You earned Rs.${toMoneyString(final.rewardAmount)} for subscribing to "${campaign.youtubeChannelName ?? task.title}".`,
      metadata: { completionId: completion.id, taskId, campaignId: completion.campaignId },
    });
  }

  return {
    verified: true,
    status: 'COMPLETED',
    rewardAmount: final.rewardAmount != null ? toMoneyString(final.rewardAmount) : null,
    newBalance: newBalance != null ? toMoneyString(newBalance) : undefined,
    alreadyCompleted: result.alreadyCredited ?? false,
  };
}

function assertCampaignIsOpen(campaign: { status: string; startsAt: Date | null; expiresAt: Date | null }) {
  const now = new Date();
  if (campaign.status !== 'ACTIVE') throw Errors.conflict('CAMPAIGN_NOT_ACTIVE', 'This campaign is not currently active.');
  if (campaign.startsAt && campaign.startsAt > now) throw Errors.conflict('CAMPAIGN_NOT_STARTED', 'This campaign has not started yet.');
  if (campaign.expiresAt && campaign.expiresAt < now) throw Errors.conflict('CAMPAIGN_EXPIRED', 'This campaign has expired.');
}

// One short, already-user-safe sentence per attempt - never an API payload,
// never a token, never Google's own message (spec §15).
async function recordAttempt(verificationId: string, reason: string | null) {
  await prisma.youTubeTaskVerification.update({
    where: { id: verificationId },
    data: { attemptCount: { increment: 1 }, lastVerificationAttemptAt: new Date(), lastFailureReason: reason },
  });
}

function reasonFor(err: unknown, fallback: string): string {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code.toLowerCase().replace(/_/g, ' ') : fallback;
}
