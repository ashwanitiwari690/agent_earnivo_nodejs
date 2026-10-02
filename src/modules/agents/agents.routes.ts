import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validate.js';
import { changeAgentPasswordSchema, updateAgentSchema } from './agents.schemas.js';
import { updateNotificationPreferencesSchema } from '../users/users.schemas.js';
import { updateMyNotificationPreferencesHandler } from '../users/users.controller.js';
import { changePasswordHandler, getMeHandler, getMyNotificationPreferencesHandler, updateMeHandler } from './agents.controller.js';
import { downloadMyInvoiceHandler, myPlanHandler, mySubscriptionHistoryHandler, myUsageHandler } from '../subscriptions/subscriptions.controller.js';

export const agentsRouter = Router();

agentsRouter.use(authenticate, requireRole('AGENT'));
agentsRouter.get('/me', getMeHandler);
agentsRouter.put('/me', validateBody(updateAgentSchema), updateMeHandler);
agentsRouter.post('/me/change-password', validateBody(changeAgentPasswordSchema), changePasswordHandler);
agentsRouter.get('/me/notification-preferences', getMyNotificationPreferencesHandler);
agentsRouter.patch('/me/notification-preferences', validateBody(updateNotificationPreferencesSchema), updateMyNotificationPreferencesHandler);
agentsRouter.get('/me/subscription', myPlanHandler);
agentsRouter.get('/me/subscription/usage', myUsageHandler);
agentsRouter.get('/me/subscription/history', mySubscriptionHistoryHandler);
agentsRouter.get('/me/subscription/history/:id/invoice', downloadMyInvoiceHandler);
