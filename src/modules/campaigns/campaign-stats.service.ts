import { prisma } from '../../db/prisma.js';
import { sumDecimal, toMoney } from '../../utils/money.js';

// Shared by the agent-facing and admin-facing campaign detail endpoints
// (spec Phase 4 §16/§17, Phase 5 §24) - the agent-set reward total, basic
// funnel counts, and the running total actually paid out. Deliberately
// simple per-campaign numbers, not a full analytics dashboard.
export async function getCampaignRewardStats(campaignId: string) {
  const [tasks, completedRows, startedUserIds, campaign] = await Promise.all([
    prisma.task.findMany({ where: { campaignId, status: 'ACTIVE' }, select: { rewardAmount: true } }),
    prisma.userTaskCompletion.findMany({ where: { campaignId, status: 'COMPLETED' }, select: { rewardAmount: true } }),
    prisma.userTaskCompletion.findMany({ where: { campaignId }, distinct: ['userId'], select: { userId: true } }),
    prisma.campaign.findUnique({ where: { id: campaignId }, select: { completedCount: true, completionLimit: true, viewCount: true } }),
  ]);

  const starts = startedUserIds.length;
  const completions = campaign?.completedCount ?? 0;

  return {
    reward: toMoney(sumDecimal(tasks.map((t) => t.rewardAmount))),
    views: campaign?.viewCount ?? 0,
    starts,
    totalCompletions: completions,
    completionRate: starts > 0 ? Math.round((completions / starts) * 1000) / 10 : 0,
    totalDistributed: toMoney(sumDecimal(completedRows.map((c) => c.rewardAmount ?? 0))),
    remainingCompletions: campaign?.completionLimit != null ? Math.max(campaign.completionLimit - completions, 0) : null,
  };
}
