import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { Errors } from '../../utils/AppError.js';
import { toMoneyString } from '../../utils/money.js';
import { createNotification } from '../notifications/notifications.service.js';
import { writeAuditLog } from '../audit/audit.service.js';

// The one remaining gap in the wallet ledger (spec Phase 11 §3/§15): the
// WalletTransactionType.ADJUSTMENT enum value has existed since Phase 3, but
// nothing ever created one - every credit went through reward.service.ts
// and every debit through withdrawals.service.ts. This is the manual
// admin-initiated path for the cases neither of those cover (a goodwill
// credit, correcting a support issue, etc.), built the same way every other
// wallet mutation in this codebase is: one atomic transaction, a real
// ledger row, an audit log entry, and a user notification - never a bare
// balance overwrite.
export async function adjustUserWallet(adminUserId: string, userId: string, amount: number, reason: string) {
  if (amount === 0) throw Errors.validation('Adjustment amount must not be zero.');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound('User');

  const wallet = await prisma.userWallet.findUnique({ where: { userId } });
  if (!wallet) throw Errors.notFound('Wallet');

  try {
    const result = await prisma.$transaction(async (tx) => {
      const transaction = await tx.walletTransaction.create({
        data: {
          userId,
          type: 'ADJUSTMENT',
          amount,
          description: reason,
        },
      });

      const updatedWallet = await tx.userWallet.update({
        where: { userId },
        data: { balance: { increment: amount } },
      });

      return { transaction, wallet: updatedWallet };
    });

    await writeAuditLog({
      userId: adminUserId,
      action: 'WALLET_ADJUSTED',
      entityType: 'user_wallets',
      entityId: result.wallet.id,
      metadata: { userId, amount: toMoneyString(amount), reason },
    });

    await createNotification({
      userId,
      type: amount > 0 ? 'WALLET_CREDITED' : 'WALLET_DEBITED',
      title: amount > 0 ? 'Wallet credited' : 'Wallet adjusted',
      message: amount > 0
        ? `₹${toMoneyString(amount)} was added to your wallet: ${reason}`
        : `₹${toMoneyString(Math.abs(amount))} was deducted from your wallet: ${reason}`,
      metadata: { transactionId: result.transaction.id },
    });

    return { ...result.transaction, amount: toMoneyString(result.transaction.amount), newBalance: toMoneyString(result.wallet.balance) };
  } catch (err: any) {
    // Postgres check_violation - the CHECK (balance >= 0) constraint caught
    // a debit that would have gone negative (spec §3). Translated into the
    // same AppError shape every other validation failure uses, rather than
    // a raw 500 with a Postgres error code leaking to the client.
    if (err?.code === '23514' || /check constraint/i.test(err?.message ?? '')) {
      throw Errors.validation('This adjustment would take the wallet balance below zero.');
    }
    throw err;
  }
}

// Cross-user ledger view (Admin > Wallet & Withdrawals > Transactions) -
// every WalletTransaction platform-wide, not one user's own history the way
// users.service.ts::getMyWalletTransactions is scoped. No `status` column
// exists here deliberately: a WalletTransaction row is only ever created at
// the moment money actually moves (reward.service.ts, withdrawals.service.ts,
// adjustUserWallet above), so every row that exists already represents a
// completed transaction - there's no pending/failed state to show.
export async function listTransactions(params: { page: number; pageSize: number; type?: string; search?: string }) {
  const where: any = {
    ...(params.type ? { type: params.type } : {}),
    ...(params.search
      ? {
          OR: [
            { description: { contains: params.search, mode: 'insensitive' } },
            { user: { name: { contains: params.search, mode: 'insensitive' } } },
            { user: { phone: { contains: params.search, mode: 'insensitive' } } },
            { user: { email: { contains: params.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      include: { user: { select: { id: true, name: true, phone: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  const data = rows.map((r) => ({
    id: r.id,
    user: r.user,
    type: r.type,
    amount: toMoneyString(r.amount),
    referenceType: r.referenceType,
    description: r.description,
    createdAt: r.createdAt,
  }));

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

// Platform-wide wallet aggregate (Admin > Wallet & Withdrawals > Wallet
// Overview) - total balances currently held across every user, plus
// lifetime earned/withdrawn totals derived straight from the same
// WalletTransaction ledger listTransactions() reads, so the two pages can
// never silently disagree with each other.
export async function getWalletOverview() {
  const [balanceAgg, earnedAgg, withdrawnAgg, walletCount, pendingAgg] = await Promise.all([
    prisma.userWallet.aggregate({ _sum: { balance: true } }),
    prisma.walletTransaction.aggregate({ where: { type: { in: ['EARN', 'BONUS'] } }, _sum: { amount: true } }),
    prisma.walletTransaction.aggregate({ where: { type: 'WITHDRAWAL' }, _sum: { amount: true } }),
    prisma.userWallet.count(),
    prisma.withdrawal.aggregate({ where: { status: 'PENDING' }, _count: { _all: true }, _sum: { amount: true } }),
  ]);

  return {
    totalWalletBalance: toMoneyString(balanceAgg._sum.balance ?? 0),
    totalEarned: toMoneyString(earnedAgg._sum.amount ?? 0),
    // WITHDRAWAL rows are stored as a negative amount (a debit) - negate
    // back to a positive "total withdrawn" figure for display.
    totalWithdrawn: toMoneyString(withdrawnAgg._sum.amount ? Math.abs(Number(withdrawnAgg._sum.amount)) : 0),
    walletCount,
    pendingWithdrawals: pendingAgg._count._all,
    pendingWithdrawalAmount: toMoneyString(pendingAgg._sum.amount ?? 0),
  };
}
