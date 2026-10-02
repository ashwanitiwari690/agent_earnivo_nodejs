import { prisma } from '../../db/prisma.js';
import { toMoneyString } from '../../utils/money.js';
import { getPlatformAnalytics } from './admin-campaigns.service.js';
import { getReferralAnalyticsAdmin } from '../referrals/referrals.service.js';

const TREND_DAYS = 14;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Buckets a bounded window of rows by calendar day in JS rather than a raw
// SQL date_trunc query - there's no existing raw-SQL precedent in this
// codebase, and 14 days of users/agents/payments is a small enough row
// count that fetching just the relevant column and grouping in memory stays
// well within a single request's budget.
function bucketByDay(dates: Date[], days: number): { date: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(dayKey(d), (counts.get(dayKey(d)) ?? 0) + 1);

  const series: { date: string; value: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    series.push({ date: key, value: counts.get(key) ?? 0 });
  }
  return series;
}

function bucketSumByDay(rows: { date: Date; amount: number }[], days: number): { date: string; value: number }[] {
  const sums = new Map<string, number>();
  for (const row of rows) sums.set(dayKey(row.date), (sums.get(dayKey(row.date)) ?? 0) + row.amount);

  const series: { date: string; value: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    series.push({ date: key, value: sums.get(key) ?? 0 });
  }
  return series;
}

async function getGrowthTrends() {
  const since = new Date();
  since.setDate(since.getDate() - (TREND_DAYS - 1));
  since.setHours(0, 0, 0, 0);

  const [newUsers, newAgents, revenuePayments] = await Promise.all([
    prisma.user.findMany({ where: { role: { code: 'USER' }, createdAt: { gte: since } }, select: { createdAt: true } }),
    prisma.agentProfile.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    prisma.payment.findMany({
      where: { status: 'APPROVED', verifiedAt: { gte: since } },
      select: { verifiedAt: true, amount: true },
    }),
  ]);

  return {
    userGrowth: bucketByDay(newUsers.map((u) => u.createdAt), TREND_DAYS),
    agentGrowth: bucketByDay(newAgents.map((a) => a.createdAt), TREND_DAYS),
    revenueTrend: bucketSumByDay(
      revenuePayments.map((p) => ({ date: p.verifiedAt!, amount: Number(p.amount) })),
      TREND_DAYS,
    ),
  };
}

// Real Admin Dashboard (spec Phase 8 §2) - reuses getPlatformAnalytics() for
// the campaign-status/reward figures it already computes correctly rather
// than re-deriving them, and adds the cross-entity counts (users, agents,
// subscriptions, payments, withdrawals) that page didn't cover.
export async function getDashboardStats() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    platform,
    totalUsers,
    activeUsers,
    totalAgents,
    activeAgents,
    pendingWithdrawals,
    pendingPayments,
    activeSubscriptions,
    monthRevenue,
    allTimeRevenue,
    allTimeWithdrawals,
    referralAnalytics,
    recentTransactions,
    trends,
  ] = await Promise.all([
    getPlatformAnalytics(),
    prisma.user.count({ where: { role: { code: 'USER' } } }),
    prisma.user.count({ where: { role: { code: 'USER' }, status: 'ACTIVE' } }),
    prisma.agentProfile.count(),
    prisma.agentProfile.count({ where: { status: 'ACTIVE' } }),
    prisma.withdrawal.count({ where: { status: 'PENDING' } }),
    prisma.payment.count({ where: { status: 'PENDING' } }),
    prisma.agentSubscription.count({ where: { status: 'ACTIVE' } }),
    prisma.payment.aggregate({
      where: { status: 'APPROVED', verifiedAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    // Phase 12 §25: "Subscription revenue" / "Withdrawals" / "Referral
    // rewards" as headline totals, alongside the existing month-to-date
    // figure - reuses getReferralAnalyticsAdmin() rather than re-deriving
    // the same aggregate it already computes.
    prisma.payment.aggregate({ where: { status: 'APPROVED' }, _sum: { amount: true } }),
    prisma.withdrawal.aggregate({ where: { status: 'COMPLETED' }, _sum: { amount: true } }),
    getReferralAnalyticsAdmin(),
    prisma.walletTransaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { user: { select: { id: true, name: true, phone: true, email: true } } },
    }),
    getGrowthTrends(),
  ]);

  return {
    totalUsers,
    activeUsers,
    totalAgents,
    activeAgents,
    activeCampaigns: platform.byStatus['ACTIVE'] ?? 0,
    expiredCampaigns: platform.byStatus['EXPIRED'] ?? 0,
    completedTasks: platform.totalCompletions,
    totalRewardsDistributed: platform.totalRewardsDistributed,
    pendingWithdrawals,
    pendingAgentPayments: pendingPayments,
    activeSubscriptions,
    subscriptionRevenueThisMonth: toMoneyString(monthRevenue._sum.amount ?? 0),
    subscriptionRevenueAllTime: toMoneyString(allTimeRevenue._sum.amount ?? 0),
    withdrawalsCompletedAllTime: toMoneyString(allTimeWithdrawals._sum.amount ?? 0),
    referralRewardsAllTime: referralAnalytics.totalReferralEarnings,
    campaignsByStatus: platform.byStatus,
    ...trends,
    recentTransactions: recentTransactions.map((t) => ({
      id: t.id,
      type: t.type,
      amount: toMoneyString(t.amount),
      description: t.description,
      user: t.user,
      createdAt: t.createdAt,
    })),
  };
}
