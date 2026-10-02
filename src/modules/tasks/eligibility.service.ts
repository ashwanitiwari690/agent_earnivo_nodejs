import { prisma } from '../../db/prisma.js';
import type { TaskModel as Task } from '../../../generated/prisma/models.js';
import { resolveTaskStrategy } from './verification.service.js';

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  // Only set by checkEveryTimeCooldown - when the caller may retry.
  availableAt?: Date;
}

// EVERY_TIME otherwise repeats immediately and without limit (see
// resolveStartCycle below), which is exactly what lets someone farm the same
// task's reward back-to-back with no real gap. A completed attempt - reward
// already credited - now blocks the next start for this long, so a user has
// to come back rather than complete it in a tight loop.
export const EVERY_TIME_COOLDOWN_MS = 60 * 60 * 1000;

// Extensible on purpose (spec §22): each future rule - country, age,
// device, language, user level, daily limit, targeting, subscription
// restrictions - is meant to slot in as one more check in this function
// without touching callers. Phase 4 only wires the two checks that are
// actually needed for a working reward loop today - campaignId stays in the
// signature unused until one of those rules needs it.
export async function checkCampaignEligibility(userId: string, _campaignId: string): Promise<EligibilityResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') {
    return { eligible: false, reason: 'Your account is not eligible to complete campaigns.' };
  }

  // Future: country/age/device/language/user-level/targeting checks go here.

  return { eligible: true };
}

// ONCE campaigns pin every completion row to the same "ONCE" sentinel, so
// the userId+taskId+cycleDate unique constraint behaves exactly like the old
// userId+taskId-only one (one row per user+task, ever). DAILY campaigns use
// the current UTC date instead, so a fresh row - and a fresh reward - is
// allowed once that date changes.
export function currentCycleDate(frequency: string): string {
  return frequency === 'DAILY' ? new Date().toISOString().slice(0, 10) : 'ONCE';
}

// EVERY_TIME has no fixed cycle key at all - it advances to a brand-new
// cycle the instant the user's last attempt reaches a terminal state,
// instead of waiting for a calendar day to turn over (DAILY) or staying
// fixed forever (ONCE). An attempt still in progress - or a MANUAL task
// whose proof was rejected and can be retried - reuses its existing cycle
// so a second /start call resumes it rather than racing ahead to a new one.
export async function resolveStartCycle(userId: string, taskId: string, frequency: string, task: Pick<Task, 'configuration'>): Promise<string> {
  if (frequency !== 'EVERY_TIME') return currentCycleDate(frequency);

  const latest = await prisma.userTaskCompletion.findFirst({
    where: { userId, taskId },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) return '1';

  const resumable =
    latest.status === 'STARTED' ||
    latest.status === 'SUBMITTED' ||
    latest.status === 'PENDING' ||
    (latest.status === 'REJECTED' && (resolveTaskStrategy(task) === 'MANUAL' || resolveTaskStrategy(task) === 'TIME_ON_SITE'));
  if (resumable) return latest.cycleDate;

  const previousCycle = Number(latest.cycleDate);
  return String(Number.isFinite(previousCycle) ? previousCycle + 1 : Date.now());
}

// Which completion row counts as this user's current attempt at a task right
// now - the same row a fresh /start would resume and the same one the feed
// should describe. ONCE/DAILY key off the cycleDate a /start would use;
// EVERY_TIME has no fixed cycle key at all (see resolveStartCycle), so the
// most recent attempt is the closest equivalent. Shared by the campaign feed
// serializer and YouTube subscription verification so both always agree on
// which attempt they are talking about.
export function findCurrentCompletion(userId: string, taskId: string, completionFrequency: string) {
  if (completionFrequency === 'EVERY_TIME') {
    return prisma.userTaskCompletion.findFirst({ where: { userId, taskId }, orderBy: { createdAt: 'desc' } });
  }
  const cycleDate = currentCycleDate(completionFrequency);
  return prisma.userTaskCompletion.findUnique({ where: { userId_taskId_cycleDate: { userId, taskId, cycleDate } } });
}

// EVERY_TIME only: whether this user is still waiting out the post-completion
// cooldown on this task. Deliberately keyed off the most recent COMPLETED
// row rather than the most recent row overall - a REJECTED or abandoned
// attempt never earned anything, so it must not extend a wait that a real
// completion already started. Checked as its own gate (not folded into
// resolveStartCycle) because resolveStartCycle only computes which cycle a
// new attempt would use - it has nothing to refuse with.
export async function checkEveryTimeCooldown(userId: string, taskId: string): Promise<EligibilityResult> {
  const lastCompleted = await prisma.userTaskCompletion.findFirst({
    where: { userId, taskId, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    select: { completedAt: true },
  });
  if (!lastCompleted?.completedAt) return { eligible: true };

  const availableAt = new Date(lastCompleted.completedAt.getTime() + EVERY_TIME_COOLDOWN_MS);
  if (availableAt <= new Date()) return { eligible: true };

  const minutesRemaining = Math.max(1, Math.ceil((availableAt.getTime() - Date.now()) / 60000));
  return {
    eligible: false,
    reason: `You can do this task again in ${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'}.`,
    availableAt,
  };
}

export async function checkTaskEligibility(userId: string, taskId: string, cycleDate: string): Promise<EligibilityResult> {
  const existing = await prisma.userTaskCompletion.findUnique({
    where: { userId_taskId_cycleDate: { userId, taskId, cycleDate } },
  });

  if (existing) {
    if (existing.status === 'COMPLETED' || existing.status === 'APPROVED') {
      return { eligible: false, reason: 'You have already completed this task.' };
    }
    if (existing.status === 'PENDING') {
      return { eligible: false, reason: 'Your proof for this task is already under review.' };
    }
    if (existing.status === 'REJECTED') {
      // Proof/admin-review tasks (MANUAL) and dwell-time tasks (TIME_ON_SITE,
      // Website Promotion) allow a fresh attempt after rejection - every
      // other strategy keeps the original one-shot-only rule.
      const task = await prisma.task.findUnique({ where: { id: taskId }, select: { configuration: true } });
      const strategy = task ? resolveTaskStrategy(task) : null;
      if (strategy === 'MANUAL' || strategy === 'TIME_ON_SITE') {
        return { eligible: true };
      }
      return { eligible: false, reason: 'This task submission was rejected and cannot be retried.' };
    }
    // STARTED/SUBMITTED - an in-progress attempt already exists; resume it
    // rather than allow a second row (the unique constraint would reject a
    // second row anyway).
    return { eligible: true };
  }

  return { eligible: true };
}
