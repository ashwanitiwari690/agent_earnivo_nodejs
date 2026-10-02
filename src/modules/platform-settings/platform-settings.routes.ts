import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validateBody } from '../../middleware/validate.js';
import { imageUpload } from '../../middleware/upload.js';
import { updatePaymentConfigSchema } from './platform-settings.schemas.js';
import { getPaymentConfigHandler, updatePaymentConfigHandler, uploadQrImageHandler } from './platform-settings.controller.js';

export const platformSettingsRouter = Router();

platformSettingsRouter.use(authenticate);

// Any authenticated role can read the config (Agent's payment screen needs
// the QR/UPI details); only Admin can change it.
platformSettingsRouter.get('/payment-config', getPaymentConfigHandler);
platformSettingsRouter.put('/payment-config', requireRole('ADMIN'), validateBody(updatePaymentConfigSchema), updatePaymentConfigHandler);
platformSettingsRouter.post(
  '/payment-config/qr-image',
  requireRole('ADMIN'),
  imageUpload('platform').single('image'),
  uploadQrImageHandler,
);
