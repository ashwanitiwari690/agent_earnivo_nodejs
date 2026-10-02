import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validate.js';
import { faqInputSchema, faqUpdateSchema, updateCmsPageSchema, updateContactConfigSchema } from './cms.schemas.js';
import {
  createFaqHandler,
  deleteFaqHandler,
  getContactConfigHandler,
  getPageAdminHandler,
  getPublishedPageHandler,
  listFaqsAdminHandler,
  listPublishedFaqsHandler,
  updateContactConfigHandler,
  updateFaqHandler,
  updatePageHandler,
} from './cms.controller.js';

export const cmsRouter = Router();

cmsRouter.use(authenticate);

// Public (any authenticated role) - About/Terms/Privacy/FAQ/Contact are the
// same regardless of USER/AGENT/ADMIN. The :type param is validated inline
// in cms.service.ts (Errors.validation on anything not ABOUT/TERMS/PRIVATE),
// matching the existing req.params.id-as-string convention used everywhere
// else in this codebase rather than introducing a new params-validation
// middleware for one route family.
cmsRouter.get('/pages/:type', getPublishedPageHandler);
cmsRouter.get('/faqs', listPublishedFaqsHandler);
cmsRouter.get('/contact', getContactConfigHandler);

// Admin-only management
cmsRouter.get('/admin/pages/:type', requireRole('ADMIN'), getPageAdminHandler);
cmsRouter.put('/admin/pages/:type', requireRole('ADMIN'), validateBody(updateCmsPageSchema), updatePageHandler);

cmsRouter.get('/admin/faqs', requireRole('ADMIN'), listFaqsAdminHandler);
cmsRouter.post('/admin/faqs', requireRole('ADMIN'), validateBody(faqInputSchema), createFaqHandler);
cmsRouter.put('/admin/faqs/:id', requireRole('ADMIN'), validateBody(faqUpdateSchema), updateFaqHandler);
cmsRouter.delete('/admin/faqs/:id', requireRole('ADMIN'), deleteFaqHandler);

cmsRouter.put('/admin/contact', requireRole('ADMIN'), validateBody(updateContactConfigSchema), updateContactConfigHandler);
