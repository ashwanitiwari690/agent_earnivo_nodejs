import { Router } from 'express';
import { listPlansHandler } from './subscriptions.controller.js';

export const subscriptionsRouter = Router();

// Public - listPlansHandler returns nothing user-specific (just the active
// plan catalog), and the marketing landing page needs to show real,
// admin-configured pricing/features to visitors who aren't signed in at
// all. Every other route an agent's own subscription lives on
// (agents.routes.ts's /agents/me/subscription*) stays authenticated.
subscriptionsRouter.get('/plans', listPlansHandler);
