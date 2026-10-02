import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validate.js';
import { trackAdEventSchema } from './ads.schemas.js';
import { getPlacementHandler, trackEventHandler } from './ads.controller.js';

export const adsRouter = Router();

adsRouter.use(authenticate);

adsRouter.get('/placements/:placement', getPlacementHandler);
adsRouter.post('/track', validateBody(trackAdEventSchema), trackEventHandler);
