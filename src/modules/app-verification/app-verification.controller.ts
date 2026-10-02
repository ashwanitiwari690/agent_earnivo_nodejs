import { Request, Response } from 'express';
import * as appVerificationService from './app-verification.service.js';

export async function confirmHandler(req: Request, res: Response) {
  const result = await appVerificationService.confirmAppInstall(req.body.apiKey, req.body.advertisingId);
  res.json({ success: true, data: result });
}
