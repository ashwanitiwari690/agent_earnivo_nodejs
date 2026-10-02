import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { toMoneyString } from '../../utils/money.js';
import { creditReward } from '../tasks/reward.service.js';
import { createNotification } from '../notifications/notifications.service.js';
import { resolveTaskStrategy } from '../tasks/verification.service.js';

// The query parameter the promoted website reads its one-time credential
// from. Deliberately namespaced rather than something generic like `token`,
// which a site's own auth/newsletter/unsubscribe flows are likely to already
// use - a collision there would have the site handing Earnivo's token to its
// own code, or its own token to ours.
export const VERIFICATION_TOKEN_PARAM = 'ev_token';

// Fallback only, matching verification.service.ts's own DEFAULT_DWELL_SECONDS
// - the normal path is the agent-configured visitDurationSeconds read off
// the task's configuration.
const DEFAULT_DWELL_SECONDS = 60;

// Appends the token to whatever URL the agent configured, preserving any
// query string and fragment the destination already had. Built here rather
// than in tasks.service.ts so the parameter name has exactly one definition,
// shared by the side that writes it and the side that documents it to agents.
export function buildVerificationUrl(destinationUrl: string | null, token: string): string | undefined {
  if (!destinationUrl) return undefined;
  try {
    const url = new URL(destinationUrl);
    url.searchParams.set(VERIFICATION_TOKEN_PARAM, token);
    return url.toString();
  } catch {
    // A destination that isn't a parseable URL can't be decorated safely -
    // the client falls back to opening it as-is, and the visit simply can't
    // be token-verified. Campaign creation validates the URL format, so this
    // guards legacy rows rather than an expected path.
    return undefined;
  }
}

function requiredDwellSeconds(configuration: unknown): number {
  return Number((configuration as Record<string, unknown> | null)?.['visitDurationSeconds']) || DEFAULT_DWELL_SECONDS;
}

// Resolves the (apiKey, token) pair the promoted website sends into the exact
// attempt it belongs to. Both halves have to agree: the token identifies one
// user's one attempt, and the API key proves the caller is the site that
// campaign actually belongs to - so a token leaked from one campaign's URL
// can't be redeemed through another campaign's integration.
async function resolveAttempt(apiKey: string, token: string) {
  const campaign = await prisma.campaign.findUnique({ where: { websiteVerificationApiKey: apiKey } });
  if (!campaign) throw Errors.forbidden('Invalid API key.');

  const completion = await prisma.userTaskCompletion.findUnique({
    where: { verificationToken: token },
    include: { task: true },
  });
  // One message for "no such token" and "token belongs to another campaign":
  // telling an anonymous caller which of the two it hit would turn this into
  // an oracle for probing tokens that exist elsewhere on the platform.
  if (!completion || completion.campaignId !== campaign.id) throw Errors.forbidden('Invalid or expired verification token.');
  if (resolveTaskStrategy(completion.task) !== 'WEBSITE_TOKEN') {
    throw Errors.validation('This campaign is not configured for website verification.');
  }

  return { campaign, completion };
}

// Called by the promoted website as its page loads, with the token it just
// read out of the URL. Read-only on purpose: it tells the site how long this
// visitor still has to stay before the reward button should appear, and
// nothing here credits anything or advances the attempt's state.
export async function getVerificationSession(apiKey: string, token: string) {
  const { campaign, completion } = await resolveAttempt(apiKey, token);

  const required = requiredDwellSeconds(completion.task.configuration);
  const elapsedSeconds = Math.floor((Date.now() - completion.startedAt.getTime()) / 1000);
  const expired = completion.verificationTokenExpiresAt != null && completion.verificationTokenExpiresAt < new Date();

  return {
    campaignName: campaign.campaignName,
    taskTitle: completion.task.title,
    // The reward as it will actually be credited (Task.rewardAmount is what
    // creditReward snapshots), so the site can show a real number rather
    // than the agent hardcoding a guess into their own markup.
    rewardAmount: toMoneyString(completion.task.rewardAmount),
    requiredSeconds: required,
    remainingSeconds: Math.max(0, required - elapsedSeconds),
    status: completion.status,
    alreadyCompleted: completion.status === 'COMPLETED',
    expired,
  };
}

// The one place a Website Promotion reward is credited. Called by the
// promoted website itself when the visitor clicks its reward button - a
// browser with no Earnivo session at all, which is exactly why the token
// (minted in tasks.service.ts's startTask) is what carries the identity of
// the user, task and attempt through the round trip.
export async function confirmWebsiteVisit(apiKey: string, token: string) {
  const { completion } = await resolveAttempt(apiKey, token);

  // Idempotent: a site that retries after a network timeout - or a visitor
  // who reloads the page and clicks again - must get the same answer back,
  // not an error suggesting something went wrong.
  if (completion.status === 'COMPLETED') {
    return {
      status: completion.status,
      rewardAmount: completion.rewardAmount != null ? toMoneyString(completion.rewardAmount) : null,
      alreadyCompleted: true,
    };
  }
  if (completion.status !== 'STARTED' && completion.status !== 'SUBMITTED') {
    throw Errors.conflict('INVALID_STATE', 'This task is not currently awaiting verification.');
  }
  if (completion.verificationTokenExpiresAt != null && completion.verificationTokenExpiresAt < new Date()) {
    throw Errors.validation('This verification link has expired. Start the task again in the Earnivo app.');
  }

  // The actual guarantee that the visitor stayed, re-derived here from the
  // server-recorded startedAt rather than trusting the site's own countdown:
  // a page that shows its button early, a tampered client, or a direct call
  // to this endpoint all fail the same check.
  const required = requiredDwellSeconds(completion.task.configuration);
  const elapsedSeconds = Math.floor((Date.now() - completion.startedAt.getTime()) / 1000);
  if (elapsedSeconds < required) {
    throw Errors.validation(`Please stay on the page for ${required} seconds - ${required - elapsedSeconds} to go.`);
  }

  const result = await creditReward(completion.id);
  const final = await prisma.userTaskCompletion.findUniqueOrThrow({ where: { id: completion.id } });

  if (result.credited && final.rewardAmount != null) {
    await createNotification({
      userId: completion.userId,
      type: 'REWARD_CREDITED',
      title: 'Website visit verified - reward credited',
      message: `You earned ₹${toMoneyString(final.rewardAmount)} for visiting "${completion.task.title}".`,
      metadata: { completionId: completion.id, taskId: completion.taskId, campaignId: completion.campaignId },
    });
  }

  return {
    status: final.status,
    rewardAmount: final.rewardAmount != null ? toMoneyString(final.rewardAmount) : null,
    alreadyCompleted: result.alreadyCredited ?? false,
  };
}
