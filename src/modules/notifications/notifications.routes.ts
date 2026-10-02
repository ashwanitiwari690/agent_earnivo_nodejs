import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { listNotificationsQuerySchema, registerDeviceSchema, unregisterDeviceSchema } from './notifications.schemas.js';
import {
  listMyNotificationsHandler,
  markAllReadHandler,
  markReadHandler,
  registerDeviceHandler,
  unregisterDeviceHandler,
} from './notifications.controller.js';

// Every authenticated role (USER/AGENT/ADMIN) reads only its own
// notifications - no requireRole restriction needed since the service scopes
// every query to req.user.id.
export const notificationsRouter = Router();

notificationsRouter.use(authenticate);
notificationsRouter.get('/', validateQuery(listNotificationsQuerySchema), listMyNotificationsHandler);
notificationsRouter.post('/mark-all-read', markAllReadHandler);

// Push-token registration. POST is idempotent on the token (upsert), so the
// client can safely call it on every launch without checking first.
//
// Declared before the '/:id/read' route below: Express matches in
// declaration order, and ':id' would otherwise swallow '/devices' and try
// to mark a notification with that literal id as read.
notificationsRouter.post('/devices', validateBody(registerDeviceSchema), registerDeviceHandler);
// DELETE with a body rather than the token in the path: an FCM token is
// long and contains ':' and '/', so putting it in a URL means escaping it
// correctly on both ends and leaving it in every access log.
notificationsRouter.delete('/devices', validateBody(unregisterDeviceSchema), unregisterDeviceHandler);

notificationsRouter.post('/:id/read', markReadHandler);
