import { z } from 'zod';

export const redeemGameRewardSchema = z.object({
  gameCode: z.string().trim().min(2).max(50),
  mobileNumber: z.string().trim().min(10).max(13),
  // A hard sanity ceiling, not a real balance check (games are
  // unauthenticated - see the schema.prisma comment on GameCoinConversion
  // for why the backend can't verify a true coin balance). This only
  // blocks an obviously-forged/overflow value from ever reaching the
  // conversion math.
  coins: z.coerce.number().int().positive().max(10_000_000),
  // Client-generated idempotency key (spec Phase 15A §8/§9) - e.g. a UUID
  // the game mints once per redemption attempt and resends unchanged on
  // any retry of that exact same attempt.
  idempotencyKey: z.string().trim().min(6).max(100),
});

export const createGameSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(50),
  name: z.string().trim().min(2).max(100),
  isActive: z.boolean().default(true),
  minimumCoins: z.coerce.number().int().min(1).default(1000),
  coinsPerConversion: z.coerce.number().int().min(1).default(1000),
  rupeesPerConversion: z.coerce.number().int().min(1).default(10),
});

export const updateGameSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  isActive: z.boolean().optional(),
  minimumCoins: z.coerce.number().int().min(1).optional(),
  coinsPerConversion: z.coerce.number().int().min(1).optional(),
  rupeesPerConversion: z.coerce.number().int().min(1).optional(),
});
