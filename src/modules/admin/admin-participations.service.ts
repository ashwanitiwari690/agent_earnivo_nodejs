import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { toMoneyString } from '../../utils/money.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { createNotification } from '../notifications/notifications.service.js';
import { creditReward } from '../tasks/reward.service.js';
import { emitTaskCompletionUpdate } from '../../realtime/socket.service.js';

// Admin visibility into individual campaign participations (spec Phase 6
// §20) - reuses UserTaskCompletion (the existing Phase 4 "participation"
// record) rather than a new model; this is a read-only listing over it.
export async function listParticipations(params: {
  page: number;
  pageSize: number;
  status?: string;
  campaignId?: string;
  userId?: string;
  search?: string;
}) {
  const where = {
    ...(params.status ? { status: params.status as any } : {}),
    ...(params.campaignId ? { campaignId: params.campaignId } : {}),
    ...(params.userId ? { userId: params.userId } : {}),
    // Powers the User Activity page's search box - this is the same
    // UserTaskCompletion listing the Tasks (proof review) page already
    // uses, just reachable without the status filter and with free-text
    // search added on top.
    ...(params.search
      ? {
          OR: [
            { user: { name: { contains: params.search, mode: 'insensitive' as const } } },
            { user: { phone: { contains: params.search, mode: 'insensitive' as const } } },
            { campaign: { campaignName: { contains: params.search, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.userTaskCompletion.findMany({
      where,
      include: {
        user: { select: { id: true, phone: true, email: true, name: true } },
        task: { select: { id: true, title: true } },
        campaign: { select: { id: true, campaignName: true, campaignType: { select: { code: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.userTaskCompletion.count({ where }),
  ]);

  const data = rows.map((r) => ({
    id: r.id,
    user: r.user,
    campaign: { id: r.campaign.id, name: r.campaign.campaignName, type: r.campaign.campaignType },
    task: r.task,
    status: r.status,
    rewardAmount: r.rewardAmount != null ? toMoneyString(r.rewardAmount) : null,
    proofImageUrl: r.proofImageUrl,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  }));

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

async function loadParticipationOrThrow(id: string) {
  const completion = await prisma.userTaskCompletion.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, phone: true, email: true, name: true } },
      task: { select: { id: true, title: true, instructions: true, rewardAmount: true } },
      campaign: { select: { id: true, campaignName: true, destinationUrl: true, campaignType: { select: { code: true, name: true } } } },
    },
  });
  if (!completion) throw Errors.notFound('Submission');
  return completion;
}

export async function getParticipationDetail(id: string) {
  const r = await loadParticipationOrThrow(id);
  return {
    id: r.id,
    user: r.user,
    campaign: { id: r.campaign.id, name: r.campaign.campaignName, destinationUrl: r.campaign.destinationUrl, type: r.campaign.campaignType },
    task: { id: r.task.id, title: r.task.title, instructions: r.task.instructions, rewardAmount: toMoneyString(r.task.rewardAmount) },
    status: r.status,
    rewardAmount: r.rewardAmount != null ? toMoneyString(r.rewardAmount) : null,
    proofImageUrl: r.proofImageUrl,
    rejectionReason: r.rejectionReason,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    startedAt: r.startedAt,
    submittedAt: r.submittedAt,
    completedAt: r.completedAt,
  };
}

// Approval for a PENDING (proof/admin-review) participation - reuses
// creditReward() exactly as the auto-verified path does, rather than a
// second wallet-crediting implementation. That function's own atomic
// `updateMany ... WHERE status != COMPLETED` guard is the real protection
// against a double-credit from two concurrent approve clicks/requests; the
// PENDING pre-check here only exists to fail fast with a clear message.
export async function approveParticipation(adminUserId: string, id: string) {
  const completion = await loadParticipationOrThrow(id);
  if (completion.status !== 'PENDING') {
    throw Errors.conflict('ALREADY_REVIEWED', 'This submission has already been reviewed.');
  }

  await prisma.userTaskCompletion.update({ where: { id }, data: { reviewedBy: adminUserId, reviewedAt: new Date() } });

  const result = await creditReward(id);
  if (!result.credited) {
    throw Errors.conflict('ALREADY_REVIEWED', 'This submission has already been reviewed.');
  }

  await writeAuditLog({
    userId: adminUserId,
    action: 'TASK_PROOF_APPROVED',
    entityType: 'user_task_completions',
    entityId: id,
    metadata: { campaignId: completion.campaignId, taskId: completion.taskId, userId: completion.userId },
  });

  await createNotification({
    userId: completion.userId,
    type: 'TASK_PROOF_APPROVED',
    title: 'Proof approved',
    message: `Your proof for "${completion.task.title}" was approved. ₹${toMoneyString(completion.task.rewardAmount)} has been credited.`,
    metadata: { completionId: id },
  });

  return { id, status: 'COMPLETED', credited: result.credited };
}

// Same atomic-guard shape as reject flows elsewhere in this codebase
// (payments): an `updateMany` scoped to `status: 'PENDING'` so a second
// concurrent reject (or an approve racing a reject) can only ever succeed
// once.
export async function rejectParticipation(adminUserId: string, id: string, reason: string) {
  const completion = await loadParticipationOrThrow(id);
  if (completion.status !== 'PENDING') {
    throw Errors.conflict('ALREADY_REVIEWED', 'This submission has already been reviewed.');
  }

  const guarded = await prisma.userTaskCompletion.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'REJECTED', rejectionReason: reason, reviewedBy: adminUserId, reviewedAt: new Date() },
  });
  if (guarded.count === 0) {
    throw Errors.conflict('ALREADY_REVIEWED', 'This submission has already been reviewed.');
  }

  await writeAuditLog({
    userId: adminUserId,
    action: 'TASK_PROOF_REJECTED',
    entityType: 'user_task_completions',
    entityId: id,
    metadata: { campaignId: completion.campaignId, taskId: completion.taskId, userId: completion.userId, reason },
  });

  await createNotification({
    userId: completion.userId,
    type: 'TASK_PROOF_REJECTED',
    title: 'Proof rejected',
    message: `Your proof for "${completion.task.title}" was rejected: ${reason}`,
    metadata: { completionId: id, reason },
  });

  // Live update for the Ionic campaign-detail page if the user still has it
  // open waiting on this exact submission - mirrors the push creditReward()
  // already fires for an approval, so "Under review" doesn't sit stale until
  // the user manually revisits the page.
  emitTaskCompletionUpdate(completion.userId, {
    completionId: id,
    taskId: completion.taskId,
    campaignId: completion.campaignId,
    status: 'REJECTED',
    rejectionReason: reason,
  });

  return { id, status: 'REJECTED' };
}
