import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { resolveSortField, resolveSortOrder } from '../../utils/sorting.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { getCampaignRewardStats } from '../campaigns/campaign-stats.service.js';
import { toMoney } from '../../utils/money.js';
import { createNotification } from '../notifications/notifications.service.js';

async function notifyAgent(agentId: string, input: { type: string; title: string; message: string; metadata?: Record<string, unknown> }) {
  const agent = await prisma.agentProfile.findUnique({ where: { id: agentId }, select: { userId: true } });
  if (!agent) return;
  await createNotification({ userId: agent.userId, ...input });
}

const CAMPAIGN_SORT_FIELDS = ['createdAt', 'campaignName', 'status', 'expiresAt', 'viewCount', 'clickCount'] as const;

export async function listAll(params: {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
  sortBy?: string;
  sortOrder?: string;
}) {
  const where = {
    ...(params.status ? { status: params.status as any } : {}),
    ...(params.q ? { campaignName: { contains: params.q, mode: 'insensitive' as const } } : {}),
  };
  const sortField = resolveSortField(params.sortBy, CAMPAIGN_SORT_FIELDS, 'createdAt');
  const sortOrder = resolveSortOrder(params.sortOrder);
  const [data, total] = await Promise.all([
    prisma.campaign.findMany({
      where,
      include: { campaignType: true, agent: { select: { id: true, name: true, businessName: true } } },
      orderBy: { [sortField]: sortOrder },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.campaign.count({ where }),
  ]);
  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export async function getById(id: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { campaignType: true, agent: true, creatives: true, tasks: true },
  });
  if (!campaign) throw Errors.notFound('Campaign');

  const stats = await getCampaignRewardStats(id);
  // Admin visibility into the type-specific fields (spec §23) - the same
  // configuration keys the Agent form collected and the User feed
  // displays, minus the backend-only verificationStrategy key.
  const tasks = campaign.tasks.map((t) => ({
    ...t,
    details: Object.fromEntries(Object.entries((t.configuration ?? {}) as Record<string, unknown>).filter(([key]) => key !== 'verificationStrategy')),
  }));
  return { ...campaign, ...stats, tasks };
}

async function requireStatus(id: string, expected: string | string[]) {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) throw Errors.notFound('Campaign');
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(campaign.status)) {
    throw Errors.conflict('INVALID_STATUS_TRANSITION', `Campaign must be ${allowed.join(' or ')} for this action (currently ${campaign.status}).`);
  }
  return campaign;
}

export async function approve(adminUserId: string, id: string) {
  await requireStatus(id, 'PENDING_REVIEW');
  const campaign = await prisma.campaign.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date() } });
  await writeAuditLog({ userId: adminUserId, action: 'CAMPAIGN_APPROVED', entityType: 'campaigns', entityId: id });
  await notifyAgent(campaign.agentId, {
    type: 'CAMPAIGN_APPROVED',
    title: 'Campaign approved',
    message: `Your campaign "${campaign.campaignName}" was approved.`,
    metadata: { campaignId: id },
  });
  return campaign;
}

export async function reject(adminUserId: string, id: string, reason: string) {
  await requireStatus(id, 'PENDING_REVIEW');
  const campaign = await prisma.campaign.update({
    where: { id },
    data: { status: 'REJECTED', rejectionReason: reason },
  });
  await writeAuditLog({ userId: adminUserId, action: 'CAMPAIGN_REJECTED', entityType: 'campaigns', entityId: id, metadata: { reason } });
  await notifyAgent(campaign.agentId, {
    type: 'CAMPAIGN_REJECTED',
    title: 'Campaign rejected',
    message: `Your campaign "${campaign.campaignName}" was rejected: ${reason}`,
    metadata: { campaignId: id },
  });
  return campaign;
}

// Terminal, admin-only housekeeping: only ever reached from an already-
// terminal-for-users status, so archiving can never interrupt anyone mid
// campaign. Tasks/completions/transactions are left completely untouched -
// archiving is a status flag, not a data operation (spec §2/§7).
export async function archive(adminUserId: string, id: string) {
  await requireStatus(id, ['COMPLETED', 'EXPIRED', 'REJECTED']);
  const campaign = await prisma.campaign.update({ where: { id }, data: { status: 'ARCHIVED' } });
  await writeAuditLog({ userId: adminUserId, action: 'CAMPAIGN_ARCHIVED', entityType: 'campaigns', entityId: id });
  return campaign;
}

// Platform-wide operational counts (spec §25) - deliberately basic: status
// breakdown, distinct participating users, total completions, total INR
// distributed. Nothing per-campaign here; that's getCampaignRewardStats.
export async function getPlatformAnalytics() {
  const [statusCounts, participatingUsers, totalCompletions, distributed] = await Promise.all([
    prisma.campaign.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.userTaskCompletion.findMany({
      where: { status: 'COMPLETED' },
      distinct: ['userId'],
      select: { userId: true },
    }),
    prisma.userTaskCompletion.count({ where: { status: 'COMPLETED' } }),
    prisma.walletTransaction.aggregate({
      where: { type: 'EARN', referenceType: 'TASK_COMPLETION' },
      _sum: { amount: true },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) byStatus[row.status] = row._count._all;

  return {
    totalCampaigns: statusCounts.reduce((sum, row) => sum + row._count._all, 0),
    byStatus,
    totalUsersParticipating: participatingUsers.length,
    totalCompletions,
    totalRewardsDistributed: toMoney(distributed._sum.amount ?? 0),
  };
}
