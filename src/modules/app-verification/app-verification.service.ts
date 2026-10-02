import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { toMoneyString } from '../../utils/money.js';
import { creditReward } from '../tasks/reward.service.js';
import { createNotification } from '../notifications/notifications.service.js';

// Called by the promoted app itself (no Earnivo user session at all - see
// app-verification.routes.ts, which deliberately has no `authenticate`
// middleware) once it has read this device's own copy of the same OS
// Advertising ID the Ionic app captured at /tasks/:id/start time
// (tasks.service.ts#startTask). This is the one place that actually credits
// an App Promotion reward - there is no self-confirmation click for these
// tasks (campaign-tasks.service.ts stamps them APP_DOWNLOAD instead of
// USER_CONFIRMATION).
export async function confirmAppInstall(apiKey: string, advertisingId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { appVerificationApiKey: apiKey } });
  if (!campaign) throw Errors.forbidden('Invalid API key.');

  // Most recent attempt for this campaign+device, any status - "most recent"
  // so a device that started (and abandoned) this task once before, then
  // started it again in a later cycle, matches the live attempt rather than
  // a stale one the unique(userId, taskId, cycleDate) constraint has already
  // moved past. Not filtered to STARTED here: the promoted app may retry
  // this call (e.g. after a network timeout even though the first call
  // already succeeded), and that retry must be a harmless no-op, not an
  // error that looks like "nothing was ever pending".
  const completion = await prisma.userTaskCompletion.findFirst({
    where: { campaignId: campaign.id, advertisingId },
    orderBy: { createdAt: 'desc' },
    include: { task: true },
  });
  if (!completion) {
    throw Errors.validation('No pending verification found for this device on this campaign.');
  }
  if (completion.status === 'COMPLETED') {
    return { status: completion.status, rewardAmount: completion.rewardAmount != null ? toMoneyString(completion.rewardAmount) : null, alreadyCompleted: true };
  }
  if (completion.status !== 'STARTED') {
    throw Errors.conflict('INVALID_STATE', 'This task is not currently awaiting verification.');
  }

  const result = await creditReward(completion.id);
  const final = await prisma.userTaskCompletion.findUniqueOrThrow({ where: { id: completion.id } });

  if (result.credited && final.rewardAmount != null) {
    await createNotification({
      userId: completion.userId,
      type: 'REWARD_CREDITED',
      title: 'App verified - reward credited',
      message: `You earned ₹${toMoneyString(final.rewardAmount)} for installing and opening "${completion.task.title}".`,
      metadata: { completionId: completion.id, taskId: completion.taskId, campaignId: completion.campaignId },
    });
  }

  return {
    status: final.status,
    rewardAmount: final.rewardAmount != null ? toMoneyString(final.rewardAmount) : null,
    alreadyCompleted: result.alreadyCredited ?? false,
  };
}
