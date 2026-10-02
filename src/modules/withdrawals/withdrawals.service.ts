import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { Errors } from '../../utils/AppError.js';
import { toMoneyString } from '../../utils/money.js';
import { createNotification, notifyAdmins } from '../notifications/notifications.service.js';
import { writeAuditLog } from '../audit/audit.service.js';

// Candidate for a future PlatformSetting row if this ever needs to be
// admin-configurable without a deploy; kept as a backend constant for now
// rather than hardcoding it in Angular/Ionic (spec Phase 7 §13).
const MIN_WITHDRAWAL_AMOUNT = 100;

function serializeWithdrawal(w: any) {
  return { ...w, amount: toMoneyString(w.amount) };
}

// Available balance is derived on every read, never stored (spec §14): the
// wallet's real `balance` column only changes when a withdrawal actually
// reaches COMPLETED (see completeWithdrawal below). A PENDING/PROCESSING
// request is "reserved" purely by being subtracted here.
export async function getAvailableBalance(userId: string) {
  const [wallet, reservedAgg] = await Promise.all([
    prisma.userWallet.findUnique({ where: { userId } }),
    prisma.withdrawal.aggregate({
      where: { userId, status: { in: ['PENDING', 'PROCESSING'] } },
      _sum: { amount: true },
    }),
  ]);
  if (!wallet) throw Errors.notFound('Wallet');
  const balance = wallet.balance;
  const reserved = reservedAgg._sum.amount ?? 0;
  const available = balance.minus(reserved);
  return { balance: toMoneyString(balance), reserved: toMoneyString(reserved), available: toMoneyString(available) };
}

export interface CreateWithdrawalInput {
  amount: number;
  method: 'UPI' | 'MOBILE';
  upiId?: string;
  mobileNumber?: string;
}

export async function createWithdrawal(userId: string, input: CreateWithdrawalInput) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound('User');
  if (user.status !== 'ACTIVE') throw Errors.forbidden('This account is not active.');

  if (input.amount < MIN_WITHDRAWAL_AMOUNT) {
    throw Errors.validation(`Minimum withdrawal amount is ₹${MIN_WITHDRAWAL_AMOUNT}.`);
  }

  const existingPending = await prisma.withdrawal.findFirst({
    where: { userId, status: { in: ['PENDING', 'PROCESSING'] } },
  });
  if (existingPending) {
    throw Errors.conflict('WITHDRAWAL_IN_PROGRESS', 'You already have a withdrawal request in progress.');
  }

  // Never trust a balance figure from the client - the actual available
  // balance is recomputed here, server-side, from the wallet and any
  // already-reserved (pending/processing) withdrawals (spec §13).
  const { available } = await getAvailableBalance(userId);
  if (Number(available) < input.amount) {
    throw Errors.validation('Insufficient available balance for this withdrawal.');
  }

  const withdrawal = await prisma.withdrawal.create({
    data: {
      userId,
      amount: input.amount,
      method: input.method,
      upiId: input.method === 'UPI' ? input.upiId : null,
      mobileNumber: input.method === 'MOBILE' ? input.mobileNumber : null,
      status: 'PENDING',
    },
  });

  await createNotification({
    userId,
    type: 'WITHDRAWAL_SUBMITTED',
    title: 'Withdrawal requested',
    message: `Your withdrawal request for ₹${input.amount} has been submitted and is pending review.`,
    metadata: { withdrawalId: withdrawal.id },
  });

  await notifyAdmins({
    type: 'NEW_WITHDRAWAL',
    title: 'New withdrawal request',
    message: `${user.name ?? user.phone ?? user.email ?? 'A user'} requested a withdrawal of ₹${input.amount}.`,
    metadata: { withdrawalId: withdrawal.id, userId },
  });

  return serializeWithdrawal(withdrawal);
}

export async function listMyWithdrawals(userId: string, params: { page: number; pageSize: number; status?: string }) {
  const where = { userId, ...(params.status ? { status: params.status as any } : {}) };
  const [rows, total] = await Promise.all([
    prisma.withdrawal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.withdrawal.count({ where }),
  ]);
  return { data: rows.map(serializeWithdrawal), page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export async function listWithdrawalsAdmin(params: { page: number; pageSize: number; status?: string }) {
  const where = params.status ? { status: params.status as any } : {};
  const [rows, total] = await Promise.all([
    prisma.withdrawal.findMany({
      where,
      include: { user: { select: { id: true, name: true, phone: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.withdrawal.count({ where }),
  ]);
  return { data: rows.map(serializeWithdrawal), page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

async function getWithdrawalOrThrow(id: string) {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id } });
  if (!withdrawal) throw Errors.notFound('Withdrawal');
  return withdrawal;
}

export async function markProcessing(id: string, adminUserId: string, adminRemark?: string) {
  const withdrawal = await getWithdrawalOrThrow(id);
  if (withdrawal.status !== 'PENDING') {
    throw Errors.conflict('INVALID_WITHDRAWAL_STATE', 'Only a pending withdrawal can be marked processing.');
  }

  const updated = await prisma.withdrawal.update({
    where: { id },
    data: { status: 'PROCESSING', adminRemark, processedBy: adminUserId, processedAt: new Date() },
  });

  await writeAuditLog({ userId: adminUserId, action: 'WITHDRAWAL_PROCESSING', entityType: 'withdrawals', entityId: id, metadata: {} });
  return serializeWithdrawal(updated);
}

// The only place a withdrawal ever debits the wallet - admin must
// explicitly confirm completion (spec §15: never automatic). Guarded the
// same way reward-crediting is guarded (reward.service.ts): an
// `updateMany` with a status precondition locks the row and re-evaluates
// atomically, so a double-click or retry can never double-debit.
export async function completeWithdrawal(id: string, adminUserId: string, adminRemark?: string) {
  return prisma.$transaction(async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({ where: { id } });
    if (!withdrawal) throw Errors.notFound('Withdrawal');
    if (withdrawal.status !== 'PROCESSING' && withdrawal.status !== 'PENDING') {
      throw Errors.conflict('INVALID_WITHDRAWAL_STATE', 'This withdrawal cannot be completed from its current state.');
    }

    const guarded = await tx.withdrawal.updateMany({
      where: { id, status: withdrawal.status },
      data: { status: 'COMPLETED', adminRemark, processedBy: adminUserId, processedAt: new Date() },
    });
    if (guarded.count === 0) {
      throw Errors.conflict('WITHDRAWAL_ALREADY_PROCESSED', 'This withdrawal was already processed.');
    }

    await tx.walletTransaction.create({
      data: {
        userId: withdrawal.userId,
        type: 'WITHDRAWAL',
        amount: withdrawal.amount.negated(),
        referenceType: 'WITHDRAWAL',
        referenceId: withdrawal.id,
        description: `Withdrawal via ${withdrawal.method}`,
      },
    });

    const wallet = await tx.userWallet.update({
      where: { userId: withdrawal.userId },
      data: { balance: { decrement: withdrawal.amount } },
    });

    await writeAuditLog({
      userId: adminUserId,
      action: 'WITHDRAWAL_COMPLETED',
      entityType: 'withdrawals',
      entityId: id,
      metadata: { userId: withdrawal.userId, amount: toMoneyString(withdrawal.amount) },
    });

    await createNotification({
      userId: withdrawal.userId,
      type: 'WITHDRAWAL_COMPLETED',
      title: 'Withdrawal completed',
      message: `₹${toMoneyString(withdrawal.amount)} has been sent to you.`,
      metadata: { withdrawalId: id },
    });

    return { ...serializeWithdrawal({ ...withdrawal, status: 'COMPLETED' }), newBalance: toMoneyString(wallet.balance) };
  });
}

export async function rejectWithdrawal(id: string, adminUserId: string, adminRemark: string) {
  const withdrawal = await getWithdrawalOrThrow(id);
  if (withdrawal.status === 'COMPLETED' || withdrawal.status === 'REJECTED') {
    throw Errors.conflict('INVALID_WITHDRAWAL_STATE', 'This withdrawal has already been finalized.');
  }

  // No balance reversal needed - a PENDING/PROCESSING withdrawal was only
  // ever "reserved" via the available-balance computation, never debited.
  const updated = await prisma.withdrawal.update({
    where: { id },
    data: { status: 'REJECTED', adminRemark, processedBy: adminUserId, processedAt: new Date() },
  });

  await writeAuditLog({
    userId: adminUserId,
    action: 'WITHDRAWAL_REJECTED',
    entityType: 'withdrawals',
    entityId: id,
    metadata: { userId: withdrawal.userId, reason: adminRemark },
  });

  await createNotification({
    userId: withdrawal.userId,
    type: 'WITHDRAWAL_REJECTED',
    title: 'Withdrawal rejected',
    message: `Your withdrawal request was rejected: ${adminRemark}`,
    metadata: { withdrawalId: id },
  });

  return serializeWithdrawal(updated);
}
