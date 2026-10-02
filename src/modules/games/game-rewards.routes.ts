import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validateBody } from '../../middleware/validate.js';
import { redeemGameRewardSchema } from './games.schemas.js';
import { redeemGameRewardHandler } from './games.controller.js';

export const gameRewardsRouter = Router();

// Public - the four game apps never authenticate (spec Phase 15A §11).
// This is the one endpoint in this backend that both has no auth AND moves
// real money into a wallet, so it gets the tightest per-IP limit of any
// route here. Section 14's future Game API key / signed request / nonce
// hooks would slot in as middleware ahead of redeemGameRewardHandler
// without changing this route's shape or games.service.ts's logic at all -
// that's the "prepare the architecture" this phase asks for, not an
// enforced check today.
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many redemption attempts. Try again later.' } },
});

gameRewardsRouter.post('/redeem', redeemLimiter, validateBody(redeemGameRewardSchema), redeemGameRewardHandler);
