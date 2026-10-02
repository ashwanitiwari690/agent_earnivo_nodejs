import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { imageUpload } from '../../middleware/upload.js';
import { createCampaignSchema, createTaskSchema, listCampaignsQuerySchema, listMyParticipationsQuerySchema, updateCampaignSchema, updateTaskSchema } from './campaigns.schemas.js';
import {
  activateHandler,
  analyticsHandler,
  createHandler,
  getByIdHandler,
  listHandler,
  listMyParticipationsHandler,
  listPlacementsHandler,
  listTypesHandler,
  pauseHandler,
  regenerateAppVerificationApiKeyHandler,
  regenerateWebsiteVerificationApiKeyHandler,
  removeHandler,
  stopHandler,
  submitHandler,
  taskPerformanceHandler,
  updateHandler,
  uploadCreativeImageHandler,
} from './campaigns.controller.js';
import {
  createTaskHandler,
  listTasksHandler,
  removeTaskHandler,
  updateTaskHandler,
} from './campaign-tasks.controller.js';

export const campaignsRouter = Router();

campaignsRouter.use(authenticate, requireRole('AGENT'));

// A legit agent creates campaigns occasionally, not in bursts - this exists
// to blunt scripted draft-spam, not to constrain normal use (spec Phase 5
// §28).
const campaignCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many campaigns created. Try again later.' } },
});

campaignsRouter.post('/', campaignCreateLimiter, validateBody(createCampaignSchema), createHandler);
campaignsRouter.get('/analytics', analyticsHandler);
campaignsRouter.get('/participations', validateQuery(listMyParticipationsQuerySchema), listMyParticipationsHandler);
campaignsRouter.get('/task-performance', taskPerformanceHandler);
campaignsRouter.get('/types', listTypesHandler);
campaignsRouter.get('/placements', listPlacementsHandler);
campaignsRouter.get('/', validateQuery(listCampaignsQuerySchema), listHandler);
campaignsRouter.get('/:id', getByIdHandler);
campaignsRouter.put('/:id', validateBody(updateCampaignSchema), updateHandler);
campaignsRouter.delete('/:id', removeHandler);
campaignsRouter.post('/:id/submit', submitHandler);
campaignsRouter.post('/:id/image', imageUpload('campaigns').single('image'), uploadCreativeImageHandler);
campaignsRouter.post('/:id/app-verification-key/regenerate', regenerateAppVerificationApiKeyHandler);
campaignsRouter.post('/:id/website-verification-key/regenerate', regenerateWebsiteVerificationApiKeyHandler);

// Operational lifecycle (spec "move campaign lifecycle from Admin to
// Agent"): Admin approval only gates whether a campaign is allowed to run
// at all; deciding when it actually runs is the owning Agent's call. Every
// ownership + status-transition check lives in campaigns.service.ts, not
// just the route's requireRole('AGENT') - see ownedCampaignWithStatus.
campaignsRouter.post('/:id/activate', activateHandler);
campaignsRouter.post('/:id/pause', pauseHandler);
campaignsRouter.post('/:id/stop', stopHandler);

// Phase 4: task definitions for a campaign, editable only while it's a
// DRAFT (same rule as editing the campaign itself).
campaignsRouter.get('/:id/tasks', listTasksHandler);
campaignsRouter.post('/:id/tasks', validateBody(createTaskSchema), createTaskHandler);
campaignsRouter.put('/:id/tasks/:taskId', validateBody(updateTaskSchema), updateTaskHandler);
campaignsRouter.delete('/:id/tasks/:taskId', removeTaskHandler);
