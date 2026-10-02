import { prisma } from '../../db/prisma.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { paginationMeta } from '../../utils/pagination.js';
import { toMoneyString } from '../../utils/money.js';
import { Errors } from '../../utils/AppError.js';
import { normalizePhone } from '../otp/otp.service.js';
import { createNotification } from '../notifications/notifications.service.js';

// Public (unauthenticated - the four game apps never log in). Only enough
// for a game client to know its own conversion config; never anything
// about other users/games' internals.
export function listActiveGames() {
  return prisma.game.findMany({
    where: { isActive: true },
    select: { code: true, name: true, minimumCoins: true, coinsPerConversion: true, rupeesPerConversion: true },
    orderBy: { code: 'asc' },
  });
}

export interface RedeemGameRewardInput {
  gameCode: string;
  mobileNumber: string;
  coins: number;
  idempotencyKey: string;
}

// The one authoritative place coins become rupees (spec Phase 15A: "Central
// Game Reward API" - never re-implemented per game). See the
// GameCoinConversion schema comment for why the backend trusts the
// submitted coin count but is authoritative for the conversion rate, the
// resulting rupee amount, and duplicate prevention.
export async function redeemGameReward(input: RedeemGameRewardInput) {
  const game = await prisma.game.findUnique({ where: { code: input.gameCode } });
  if (!game || !game.isActive) throw Errors.validation('Unknown or inactive game.');

  const normalizedPhone = normalizePhone(input.mobileNumber);
  const user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
  if (!user) {
    throw Errors.validation('No Earnivo account found with this mobile number. Please register in the Earnivo app first.');
  }
  if (user.status !== 'ACTIVE') throw Errors.userSuspended();

  if (input.coins < game.minimumCoins) {
    throw Errors.validation(`A minimum of ${game.minimumCoins} coins is required to redeem.`);
  }

  // Proportional, not bucketed to a whole multiple (spec Phase 15A: the full
  // submitted amount converts at the configured ratio once the minimum gate
  // is cleared - no coins are silently stranded). Decimal math throughout,
  // rounded to 2dp only at the very end, matching every other money value
  // in this codebase.
  const rupeeAmount = new Prisma.Decimal(input.coins).div(game.coinsPerConversion).mul(game.rupeesPerConversion).toDecimalPlaces(2);
  const coinsConverted = input.coins;

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // First write in the transaction, on purpose: the unique constraint
      // on (gameId, transactionReference) is what actually blocks a replay
      // of this exact request, so it must fail before any wallet credit
      // happens, not after.
      const conversion = await tx.gameCoinConversion.create({
        data: {
          gameId: game.id,
          gameName: game.name,
          userId: user.id,
          mobileNumber: normalizedPhone,
          coinsSubmitted: input.coins,
          coinsConverted,
          coinsPerConversion: game.coinsPerConversion,
          rupeesPerConversion: game.rupeesPerConversion,
          rupeeAmount,
          transactionReference: input.idempotencyKey,
          status: 'COMPLETED',
        },
      });

      await tx.walletTransaction.create({
        data: {
          userId: user.id,
          type: 'EARN',
          amount: rupeeAmount,
          referenceType: 'GAME_CONVERSION',
          referenceId: conversion.id,
          description: `${game.name}: ${coinsConverted} coins converted to ₹${toMoneyString(rupeeAmount)}`,
        },
      });

      const wallet = await tx.userWallet.update({
        where: { userId: user.id },
        data: { balance: { increment: rupeeAmount } },
      });

      return { conversion, wallet };
    });
  } catch (err: any) {
    // Prisma's own P2002 for the (gameId, transactionReference) unique
    // constraint - the same redemption request arriving twice (network
    // retry, duplicate tap, concurrent requests) is a clean, expected
    // no-op rejection, not a 500. Concurrent requests with the SAME
    // idempotencyKey race for the same DB row and Postgres's own unique-
    // index enforcement guarantees exactly one wins - no application-level
    // locking needed.
    if (err?.code === 'P2002') {
      throw Errors.conflict('DUPLICATE_CONVERSION', 'This redemption request has already been processed.');
    }
    throw err;
  }

  await createNotification({
    userId: user.id,
    type: 'GAME_REWARD_CREDITED',
    title: 'Game reward credited',
    message: `₹${toMoneyString(rupeeAmount)} was credited to your wallet from ${game.name}.`,
    metadata: { conversionId: result.conversion.id, gameCode: input.gameCode },
  });

  return {
    gameCode: input.gameCode,
    gameName: game.name,
    coinsSubmitted: input.coins,
    coinsRedeemed: coinsConverted,
    coinsPerConversion: game.coinsPerConversion,
    rupeesPerConversion: game.rupeesPerConversion,
    amountCredited: toMoneyString(rupeeAmount),
    transactionId: result.conversion.id,
    idempotencyKey: input.idempotencyKey,
    status: result.conversion.status,
    createdAt: result.conversion.createdAt,
    newWalletBalance: toMoneyString(result.wallet.balance),
  };
}

export async function getMyGameEarnings(userId: string, params: { page: number; pageSize: number }) {
  const where = { userId };
  const [rows, total, totalAgg] = await Promise.all([
    prisma.gameCoinConversion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.gameCoinConversion.count({ where }),
    prisma.gameCoinConversion.aggregate({ where: { userId, status: 'COMPLETED' }, _sum: { rupeeAmount: true } }),
  ]);

  return {
    data: rows.map((r) => ({ ...r, rupeeAmount: toMoneyString(r.rupeeAmount) })),
    page: params.page,
    pageSize: params.pageSize,
    total,
    pagination: paginationMeta(params.page, params.pageSize, total),
    totalGameEarnings: toMoneyString(totalAgg._sum.rupeeAmount ?? 0),
  };
}
