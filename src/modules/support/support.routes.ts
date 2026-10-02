import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { createTicketSchema, listTicketsQuerySchema, updateTicketAdminSchema } from './support.schemas.js';
import {
  createTicketHandler,
  getMyTicketHandler,
  listMyTicketsHandler,
  listTicketsAdminHandler,
  updateTicketAdminHandler,
} from './support.controller.js';

export const supportRouter = Router();

supportRouter.use(authenticate);

// Both USER and AGENT can raise/view their own tickets (spec §9's flow is
// identical for either role).
supportRouter.post('/', requireRole('USER', 'AGENT'), validateBody(createTicketSchema), createTicketHandler);
supportRouter.get('/me', requireRole('USER', 'AGENT'), validateQuery(listTicketsQuerySchema), listMyTicketsHandler);
supportRouter.get('/me/:id', requireRole('USER', 'AGENT'), getMyTicketHandler);

// Admin management
supportRouter.get('/admin', requireRole('ADMIN'), validateQuery(listTicketsQuerySchema), listTicketsAdminHandler);
supportRouter.put('/admin/:id', requireRole('ADMIN'), validateBody(updateTicketAdminSchema), updateTicketAdminHandler);
