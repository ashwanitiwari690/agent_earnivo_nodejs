import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { toMoneyString } from '../../utils/money.js';
import { Errors } from '../../utils/AppError.js';
import { normalizePhone } from '../otp/otp.service.js';
import { createNotification } from '../notifications/notifications.service.js';
import { writeAuditLog } from '../audit/audit.service.js';

// Closes the Admin Users Management gap deferred since Phase 7 (spec Phase
// 11 §21) - built now specifically because every underlying data source it
// needs (wallet, transactions, task history, withdrawals, referrals) already
// exists from Phases 6-9, so this is aggregation over existing tables, not
// new architecture.
export async function listUsers(params: { page: number; pageSize: number; search?: string; status?: string }) {
  const where = {
    role: { code: 'USER' as const },
    ...(params.status ? { status: params.status as any } : {}),
    ...(params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: 'insensitive' as const } },
            { phone: { contains: params.search } },
            { email: { contains: params.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: { id: true, name: true, phone: true, email: true, status: true, phoneVerified: true, createdAt: true, lastLoginAt: true },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  return { data: rows, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export async function getUserDetail(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, phone: true, email: true, status: true, phoneVerified: true, createdAt: true, lastLoginAt: true, role: { select: { code: true } } },
  });
  if (!user || user.role.code !== 'USER') throw Errors.notFound('User');

  const [wallet, earnedAgg, recentTransactions, recentTasks, recentWithdrawals, referralSummary] = await Promise.all([
    prisma.userWallet.findUnique({ where: { userId: id } }),
    prisma.walletTransaction.aggregate({ where: { userId: id, type: 'EARN' }, _sum: { amount: true } }),
    prisma.walletTransaction.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.userTaskCompletion.findMany({
      where: { userId: id },
      include: { task: { select: { title: true } }, campaign: { select: { campaignName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.withdrawal.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.referral.groupBy({ by: ['status'], where: { referrerId: id }, _count: { _all: true } }),
  ]);

  const byReferralStatus: Record<string, number> = {};
  for (const row of referralSummary) byReferralStatus[row.status] = row._count._all;

  return {
    ...user,
    wallet: wallet ? { balance: toMoneyString(wallet.balance), totalEarned: toMoneyString(earnedAgg._sum.amount ?? 0) } : null,
    recentTransactions: recentTransactions.map((t) => ({ ...t, amount: toMoneyString(t.amount) })),
    recentTasks: recentTasks.map((t) => ({
      id: t.id,
      campaignName: t.campaign.campaignName,
      taskTitle: t.task.title,
      status: t.status,
      rewardAmount: t.rewardAmount ? toMoneyString(t.rewardAmount) : null,
      date: t.createdAt,
    })),
    recentWithdrawals: recentWithdrawals.map((w) => ({ ...w, amount: toMoneyString(w.amount) })),
    referralSummary: byReferralStatus,
  };
}

export async function setUserStatus(adminUserId: string, id: string, status: 'ACTIVE' | 'SUSPENDED') {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: { select: { code: true } } } });
  if (!user || user.role.code !== 'USER') throw Errors.notFound('User');

  const updated = await prisma.user.update({ where: { id }, data: { status } });

  await writeAuditLog({
    userId: adminUserId,
    action: status === 'ACTIVE' ? 'USER_ACTIVATED' : 'USER_SUSPENDED',
    entityType: 'users',
    entityId: id,
  });

  await createNotification({
    userId: id,
    type: status === 'ACTIVE' ? 'ACCOUNT_ACTIVATED' : 'ACCOUNT_SUSPENDED',
    title: status === 'ACTIVE' ? 'Account reactivated' : 'Account suspended',
    message: status === 'ACTIVE' ? 'Your account has been reactivated.' : 'Your account has been suspended. Contact support for details.',
    metadata: {},
  });

  return { id: updated.id, status: updated.status };
}

// Mirrors user-auth.service.ts's verifyOtpAndAuthenticate's new-user branch
// (User row + UserWallet, in one transaction), minus the OTP itself and
// referral attribution (neither applies to an account an admin is creating
// directly) - the admin is vouching for this person, so it's created
// phoneVerified/ACTIVE right away rather than waiting on a real OTP.
export async function createUser(adminUserId: string, input: { name?: string; phone: string; email?: string }) {
  const phone = normalizePhone(input.phone);

  const existingPhone = await prisma.user.findUnique({ where: { phone } });
  if (existingPhone) throw Errors.conflict('PHONE_TAKEN', 'An account with this phone number already exists.');

  if (input.email) {
    const existingEmail = await prisma.user.findUnique({ where: { email: input.email } });
    if (existingEmail) throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists.');
  }

  const userRole = await prisma.role.findUniqueOrThrow({ where: { code: 'USER' } });

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: input.name,
        phone,
        email: input.email,
        phoneVerified: true,
        roleId: userRole.id,
        status: 'ACTIVE',
      },
    });
    await tx.userWallet.create({ data: { userId: created.id, balance: 0 } });
    return created;
  });

  await writeAuditLog({
    userId: adminUserId,
    action: 'USER_CREATED_BY_ADMIN',
    entityType: 'users',
    entityId: user.id,
    metadata: { phone },
  });

  return { id: user.id, name: user.name, phone: user.phone, email: user.email, status: user.status };
}
