import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateQuery } from '../../middleware/validate.js';
import { listFeedQuerySchema } from './campaign-feed.schemas.js';
import { getFeedDetailHandler, listFeedHandler } from './campaign-feed.controller.js';

// Deliberately its own path prefix rather than reusing GET /api/campaigns -
// that path is already the Agent's own-campaign-management endpoint from
// Phase 2 (different role, different shape, ownership-scoped). Reusing it
// here would either collide or silently change its meaning; §41 requires
// existing APIs keep working unchanged.
export const campaignFeedRouter = Router();
campaignFeedRouter.use(authenticate, requireRole('USER'));
campaignFeedRouter.get('/', validateQuery(listFeedQuerySchema), listFeedHandler);
campaignFeedRouter.get('/:id', getFeedDetailHandler);
