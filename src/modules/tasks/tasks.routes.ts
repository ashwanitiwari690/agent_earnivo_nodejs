import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validate.js';
import { imageUpload } from '../../middleware/upload.js';
import { startTaskSchema, submitTaskSchema } from './tasks.schemas.js';
import { getCompletionStatusHandler, startTaskHandler, submitTaskHandler, uploadTaskProofHandler } from './tasks.controller.js';
import { verifyYouTubeSubscriptionHandler } from '../youtube-verification/youtube-verification.controller.js';

// Reward-bearing endpoints, so guarded against scripted rapid-fire
// start/submit attempts - well above what a real user completing several
// campaigns in a session would ever hit (spec Phase 5 §28).
const taskActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

export const tasksRouter = Router();
tasksRouter.use(authenticate, requireRole('USER'));
tasksRouter.post('/:taskId/start', taskActionLimiter, validateBody(startTaskSchema), startTaskHandler);
// Keyed by taskId rather than completionId, unlike submit: the user presses
// Verify from a screen that knows which task it is showing, and the backend
// resolves their current attempt itself (findCurrentCompletion) - so a client
// that lost its completionId across an app restart can still verify.
//
// Shares taskActionLimiter with start/submit because it is a reward-bearing
// call, and additionally because each attempt costs real YouTube API quota:
// the limiter is what stops a stuck retry loop burning the platform's daily
// allowance (spec §8's reasoning for a button rather than polling).
tasksRouter.post('/:taskId/verify-youtube-subscription', taskActionLimiter, verifyYouTubeSubscriptionHandler);

export const taskCompletionsRouter = Router();
taskCompletionsRouter.use(authenticate, requireRole('USER'));
taskCompletionsRouter.get('/:completionId', getCompletionStatusHandler);
taskCompletionsRouter.post('/:completionId/submit', taskActionLimiter, validateBody(submitTaskSchema), submitTaskHandler);
taskCompletionsRouter.post('/:completionId/proof', taskActionLimiter, imageUpload('task-proofs').single('proof'), uploadTaskProofHandler);
