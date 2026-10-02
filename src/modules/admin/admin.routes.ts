import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import {
  activateSubscriptionSchema,
  adjustWalletSchema,
  broadcastAnnouncementSchema,
  listAuditLogsQuerySchema,
  listParticipationsQuerySchema,
  listQuerySchema,
  listSurveyResponsesQuerySchema,
  listTransactionsQuerySchema,
  planInputSchema,
  planStatusSchema,
  planUpdateSchema,
  listGameConversionsQuerySchema,
  rejectCampaignSchema,
  createAgentSchema,
  createUserSchema,
  setAgentStatusSchema,
  setEnabledSchema,
  setUserStatusSchema,
} from './admin.schemas.js';
import { listAuditLogActionsHandler, listAuditLogsHandler } from './admin-audit-logs.controller.js';
import { listSurveyResponsesHandler } from './admin-surveys.controller.js';
import { createGameSchema, updateGameSchema } from '../games/games.schemas.js';
import { adjustWalletHandler, getWalletOverviewHandler, listTransactionsHandler } from './admin-wallet.controller.js';
import { createUserHandler, getUserDetailHandler, listUsersHandler, setUserStatusHandler } from './admin-users.controller.js';
import { createAgentHandler, getAgentDetailHandler, listAgentsHandler, setAgentStatusHandler } from './admin-agents.controller.js';
import { broadcastAnnouncementHandler } from '../notifications/announcements.controller.js';
import { updateCampaignTypeRewardSchema } from '../campaigns/campaigns.schemas.js';
import {
  analyticsHandler,
  approveHandler,
  archiveHandler,
  getByIdHandler,
  listHandler,
  rejectHandler,
} from './admin-campaigns.controller.js';
import {
  deleteHandler as deleteCampaignTypeRewardHandler,
  getByCodeHandler as getCampaignTypeRewardHandler,
  listHandler as listCampaignTypeRewardsHandler,
  updateHandler as updateCampaignTypeRewardHandler,
} from './campaign-type-rewards.controller.js';
import {
  approveParticipationHandler,
  getParticipationDetailHandler,
  listParticipationsHandler,
  rejectParticipationHandler,
} from './admin-participations.controller.js';
import { getDashboardStatsHandler } from './admin-dashboard.controller.js';
import {
  activateAgentSubscriptionHandler,
  cancelAgentSubscriptionHandler,
  createPlanHandler,
  downloadAgentInvoiceHandler,
  listAgentSubscriptionsHandler,
  listPlansHandler,
  setPlanStatusHandler,
  updatePlanHandler,
} from './admin-subscriptions.controller.js';
import {
  getAdAnalyticsHandler,
  listPlacementsHandler,
  listProvidersHandler,
  setPlacementEnabledHandler,
  setProviderEnabledHandler,
} from './admin-ads.controller.js';
import { createGameHandler, listConversionsHandler, listGamesHandler as listAdminGamesHandler, updateGameHandler } from './admin-games.controller.js';

export const adminRouter = Router();

adminRouter.use(authenticate, requireRole('ADMIN'));

adminRouter.get('/dashboard', getDashboardStatsHandler);

adminRouter.get('/campaigns/analytics', analyticsHandler);
adminRouter.get('/campaigns', validateQuery(listQuerySchema), listHandler);
adminRouter.get('/campaigns/:id', getByIdHandler);
adminRouter.post('/campaigns/:id/approve', approveHandler);
adminRouter.post('/campaigns/:id/reject', validateBody(rejectCampaignSchema), rejectHandler);
// Operational lifecycle (Activate/Pause/Resume/Stop) moved to the Agent-
// owned campaign routes (campaigns.routes.ts) - Admin is the verification
// authority (approve/reject/archive), not the operator of an Agent's live
// campaign. A direct call to the old admin activate/pause endpoints now
// 404s rather than succeeding.
adminRouter.post('/campaigns/:id/archive', archiveHandler);

adminRouter.get('/campaign-type-rewards', listCampaignTypeRewardsHandler);
adminRouter.get('/campaign-type-rewards/:code', getCampaignTypeRewardHandler);
adminRouter.put('/campaign-type-rewards/:code', validateBody(updateCampaignTypeRewardSchema), updateCampaignTypeRewardHandler);
adminRouter.patch('/campaign-type-rewards/:code', validateBody(updateCampaignTypeRewardSchema), updateCampaignTypeRewardHandler);
adminRouter.delete('/campaign-type-rewards/:code', deleteCampaignTypeRewardHandler);

// Visibility + proof review into individual campaign participations (spec
// Phase 6 §20, extended for proof-upload social campaigns) - reuses
// UserTaskCompletion, the existing Phase 4 record.
adminRouter.get('/campaign-participations', validateQuery(listParticipationsQuerySchema), listParticipationsHandler);
adminRouter.get('/campaign-participations/:id', getParticipationDetailHandler);
adminRouter.post('/campaign-participations/:id/approve', approveParticipationHandler);
adminRouter.post('/campaign-participations/:id/reject', validateBody(rejectCampaignSchema), rejectParticipationHandler);

adminRouter.get('/subscription-plans', listPlansHandler);
adminRouter.post('/subscription-plans', validateBody(planInputSchema), createPlanHandler);
adminRouter.put('/subscription-plans/:id', validateBody(planUpdateSchema), updatePlanHandler);
adminRouter.patch('/subscription-plans/:id/status', validateBody(planStatusSchema), setPlanStatusHandler);

adminRouter.get('/agent-subscriptions', validateQuery(listQuerySchema), listAgentSubscriptionsHandler);
adminRouter.post('/agent-subscriptions/:id/activate', validateBody(activateSubscriptionSchema), activateAgentSubscriptionHandler);
adminRouter.post('/agent-subscriptions/:id/cancel', cancelAgentSubscriptionHandler);
adminRouter.get('/agent-subscriptions/:id/invoice', downloadAgentInvoiceHandler);

adminRouter.get('/users', validateQuery(listQuerySchema), listUsersHandler);
adminRouter.post('/users', validateBody(createUserSchema), createUserHandler);
adminRouter.get('/users/:id', getUserDetailHandler);
adminRouter.patch('/users/:id/status', validateBody(setUserStatusSchema), setUserStatusHandler);
adminRouter.post('/users/:userId/wallet-adjustment', validateBody(adjustWalletSchema), adjustWalletHandler);
adminRouter.get('/wallet-transactions', validateQuery(listTransactionsQuerySchema), listTransactionsHandler);
adminRouter.get('/wallet-overview', getWalletOverviewHandler);

adminRouter.get('/agents', validateQuery(listQuerySchema), listAgentsHandler);
adminRouter.post('/agents', validateBody(createAgentSchema), createAgentHandler);
adminRouter.get('/agents/:id', getAgentDetailHandler);
adminRouter.patch('/agents/:id/status', validateBody(setAgentStatusSchema), setAgentStatusHandler);

adminRouter.post('/announcements', validateBody(broadcastAnnouncementSchema), broadcastAnnouncementHandler);

adminRouter.get('/ads/placements', listPlacementsHandler);
adminRouter.patch('/ads/placements/:code', validateBody(setEnabledSchema), setPlacementEnabledHandler);
adminRouter.get('/ads/providers', listProvidersHandler);
adminRouter.patch('/ads/providers/:provider', validateBody(setEnabledSchema), setProviderEnabledHandler);
adminRouter.get('/ads/analytics', getAdAnalyticsHandler);

adminRouter.get('/games', listAdminGamesHandler);
adminRouter.post('/games', validateBody(createGameSchema), createGameHandler);
adminRouter.patch('/games/:code', validateBody(updateGameSchema), updateGameHandler);
adminRouter.get('/game-conversions', validateQuery(listGameConversionsQuerySchema), listConversionsHandler);

adminRouter.get('/audit-logs', validateQuery(listAuditLogsQuerySchema), listAuditLogsHandler);
adminRouter.get('/audit-logs/actions', listAuditLogActionsHandler);

adminRouter.get('/survey-responses', validateQuery(listSurveyResponsesQuerySchema), listSurveyResponsesHandler);
