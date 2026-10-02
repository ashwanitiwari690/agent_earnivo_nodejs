import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { toMoneyString } from '../../utils/money.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';

export function listGames() {
  return prisma.game.findMany({ orderBy: { code: 'asc' } });
}

export interface CreateGameInput {
  code: string;
  name: string;
  isActive?: boolean;
  minimumCoins?: number;
  coinsPerConversion?: number;
  rupeesPerConversion?: number;
}

// "Game registration" (spec Phase 15A §2) - lets Admin register a future
// fifth game (or re-add one) without a manual DB/seed edit. Never touches
// any of the four frozen game applications themselves - this only creates
// a row this backend's own redeem endpoint will recognize once that game
// starts calling it.
export async function createGame(adminUserId: string, input: CreateGameInput) {
  const existing = await prisma.game.findUnique({ where: { code: input.code } });
  if (existing) throw Errors.conflict('GAME_CODE_EXISTS', `A game with code ${input.code} already exists.`);

  const game = await prisma.game.create({ data: { ...input, updatedBy: adminUserId } });

  await writeAuditLog({
    userId: adminUserId,
    action: 'GAME_REGISTERED',
    entityType: 'games',
    entityId: game.id,
    metadata: { code: game.code, name: game.name },
  });

  return game;
}

export interface UpdateGameInput {
  name?: string;
  isActive?: boolean;
  minimumCoins?: number;
  coinsPerConversion?: number;
  rupeesPerConversion?: number;
}

export async function updateGame(adminUserId: string, code: string, input: UpdateGameInput) {
  const existing = await prisma.game.findUnique({ where: { code } });
  if (!existing) throw Errors.notFound('Game');

  const updated = await prisma.game.update({ where: { code }, data: { ...input, updatedBy: adminUserId } });

  await writeAuditLog({
    userId: adminUserId,
    action: 'GAME_CONFIG_UPDATED',
    entityType: 'games',
    entityId: updated.id,
    metadata: { code, ...input },
  });

  return updated;
}

// Admin visibility into Game -> Coins -> Conversion -> Wallet (spec §16) -
// every field an admin would need to trace one conversion end to end,
// without exposing anything a plain GameCoinConversion row doesn't already
// have.
export async function listConversions(params: { page: number; pageSize: number; gameCode?: string; userId?: string; status?: string }) {
  const where = {
    ...(params.gameCode ? { game: { code: params.gameCode } } : {}),
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.status ? { status: params.status as any } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.gameCoinConversion.findMany({
      where,
      include: { game: { select: { code: true, name: true } }, user: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.gameCoinConversion.count({ where }),
  ]);

  return {
    data: rows.map((r) => ({ ...r, rupeeAmount: toMoneyString(r.rupeeAmount) })),
    page: params.page,
    pageSize: params.pageSize,
    total,
    pagination: paginationMeta(params.page, params.pageSize, total),
  };
}
