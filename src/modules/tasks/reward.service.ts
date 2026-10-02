import { prisma } from '../../db/prisma.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { Errors } from '../../utils/AppError.js';
import { toMoneyString } from '../../utils/money.js';
import { emitTaskCompletionUpdate } from '../../realtime/socket.service.js';

export interface CreditRewardResult {
  credited: boolean;
  alreadyCredited?: boolean;
  newBalance?: Prisma.Decimal;
}

// Everything the post-commit socket push (see below) needs, gathered while
// still inside the transaction where completion/wallet are in scope - kept
// out of CreditRewardResult itself since none of the five call sites need it.
interface PendingRealtimeUpdate {
  userId: string;
  completionId: string;
  taskId: string;
  campaignId: string;
  rewardAmount: Prisma.Decimal;
  newBalance: Prisma.Decimal;
}

// The only place reward amounts are ever credited. Two independent guards make a
// double-credit impossible even under concurrent requests for the same
// completion (spec §16/§17/TEST 7/TEST 8):
//
//  1. `updateMany({ where: { status: { not: 'COMPLETED' } } })` - Postgres
//     locks the row on UPDATE, so a second concurrent call blocks until the
//     first commits, then re-evaluates the WHERE clause against the now-
//     COMPLETED row and matches zero rows. No SELECT ... FOR UPDATE needed.
//  2. `wallet_transactions` has a unique(referenceType, referenceId) index,
//     so even a bug that bypassed guard 1 would hit a unique-violation on
//     the insert rather than silently double-crediting.
export async function creditReward(completionId: string): Promise<CreditRewardResult> {
  let pendingRealtimeUpdate: PendingRealtimeUpdate | undefined;

  const result = await prisma.$transaction(async (tx) => {
    const completion = await tx.userTaskCompletion.findUnique({
      where: { id: completionId },
      include: { task: true },
    });
    if (!completion) throw Errors.notFound('Task completion');

    if (completion.status === 'COMPLETED') {
      return { credited: false, alreadyCredited: true };
    }

    const guarded = await tx.userTaskCompletion.updateMany({
      where: { id: completionId, status: { not: 'COMPLETED' } },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        rewardAmount: completion.task.rewardAmount,
        verificationStatus: 'PASSED',
      },
    });
    if (guarded.count === 0) {
      return { credited: false, alreadyCredited: true };
    }

    await tx.walletTransaction.create({
      data: {
        userId: completion.userId,
        type: 'EARN',
        amount: completion.task.rewardAmount,
        referenceType: 'TASK_COMPLETION',
        referenceId: completion.id,
        description: `Reward: ${completion.task.title}`,
      },
    });

    const wallet = await tx.userWallet.update({
      where: { userId: completion.userId },
      data: { balance: { increment: completion.task.rewardAmount } },
    });

    await maybeCompleteCampaignForUser(tx, completion.userId, completion.campaignId, completion.cycleDate);

    // Captured now (completion/wallet are only in scope inside this
    // callback) but not emitted until after the transaction actually
    // commits below - same rule every other real-time/notification call
    // site in this codebase follows, so a client is never told about a
    // credit that a serialization failure then rolls back.
    pendingRealtimeUpdate = {
      userId: completion.userId,
      completionId: completion.id,
      taskId: completion.taskId,
      campaignId: completion.campaignId,
      rewardAmount: completion.task.rewardAmount,
      newBalance: wallet.balance,
    };

    return { credited: true, newBalance: wallet.balance };
  });

  // Real-time push for whoever's waiting on this exact completion - in
  // practice, the Ionic campaign-detail page's poll loop for an App
  // Promotion or Website Promotion task, both of which are only ever
  // credited by an external callback (app-verification.service.ts,
  // website-verification.service.ts) that the user's own page has no other
  // way to learn about promptly. Fired unconditionally, unlike the
  // notification each caller usually also sends a few lines after calling
  // this - this is live state for a screen the user is actively looking at,
  // not something a notification preference should be able to silence.
  if (pendingRealtimeUpdate) {
    emitTaskCompletionUpdate(pendingRealtimeUpdate.userId, {
      completionId: pendingRealtimeUpdate.completionId,
      taskId: pendingRealtimeUpdate.taskId,
      campaignId: pendingRealtimeUpdate.campaignId,
      status: 'COMPLETED',
      rewardAmount: toMoneyString(pendingRealtimeUpdate.rewardAmount),
      newBalance: toMoneyString(pendingRealtimeUpdate.newBalance),
    });
  }

  return result;
}

// Rolls a user finishing every required task in a campaign up into the
// campaign-level completion tally (spec §18). Fires once per user per
// completion cycle, because it's only reached via a just-succeeded (i.e.
// not-yet-credited) task credit above - once ever for ONCE campaigns, once
// per day for DAILY, once per repeat for EVERY_TIME.
async function maybeCompleteCampaignForUser(tx: Prisma.TransactionClient, userId: string, campaignId: string, cycleDate: string) {
  const requiredTasks = await tx.task.findMany({
    where: { campaignId, isRequired: true, status: 'ACTIVE' },
    select: { id: true },
  });
  if (requiredTasks.length === 0) return;

  // Scoped to the cycle this completion belongs to, which is also what makes
  // the row count equal a distinct-task count (userId+taskId+cycleDate is
  // unique). Counting across every cycle would let a repeatable campaign's
  // second run at task A stand in for task B and bump the tally without the
  // user ever having finished the campaign.
  const completedRequired = await tx.userTaskCompletion.count({
    where: { userId, campaignId, taskId: { in: requiredTasks.map((t) => t.id) }, status: 'COMPLETED', cycleDate },
  });
  if (completedRequired < requiredTasks.length) return;

  const campaign = await tx.campaign.update({
    where: { id: campaignId },
    data: { completedCount: { increment: 1 } },
  });

  if (campaign.completionLimit != null && campaign.completedCount >= campaign.completionLimit && campaign.status === 'ACTIVE') {
    await tx.campaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });
  }
}
