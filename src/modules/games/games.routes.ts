import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { listGamesHandler } from './games.controller.js';

export const gamesRouter = Router();

// Public - the four game apps never authenticate (spec Master Direction
// §1). Rate-limited per IP since this is one of only two unauthenticated
// endpoints this backend exposes (the other being the redeem action in
// game-rewards.routes.ts).
const gamesListLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

gamesRouter.get('/', gamesListLimiter, listGamesHandler);
