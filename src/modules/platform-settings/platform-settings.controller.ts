import { Request, Response } from 'express';
import { Errors } from '../../utils/AppError.js';
import { publicUploadUrl } from '../../middleware/upload.js';
import { getPaymentConfig, updatePaymentConfig } from './platform-settings.service.js';

export async function getPaymentConfigHandler(_req: Request, res: Response) {
  const config = await getPaymentConfig();
  res.json({ success: true, data: config });
}

export async function updatePaymentConfigHandler(req: Request, res: Response) {
  const updated = await updatePaymentConfig(req.user!.id, req.body);
  res.json({ success: true, data: updated });
}

export async function uploadQrImageHandler(req: Request, res: Response) {
  if (!req.file) throw Errors.validation('A QR image file is required.');
  const qrImageUrl = publicUploadUrl(req.file.filename);
  const updated = await updatePaymentConfig(req.user!.id, { qrImageUrl });
  res.json({ success: true, data: updated });
}
