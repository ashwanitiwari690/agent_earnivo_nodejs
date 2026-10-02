import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { translateHandler } from './translation.controller.js';

export const translationRouter = Router();

translationRouter.use(authenticate);
translationRouter.get('/', translateHandler);
