import { Request, Response } from 'express';
import * as websiteVerificationService from './website-verification.service.js';

export async function sessionHandler(req: Request, res: Response) {
  const result = await websiteVerificationService.getVerificationSession(req.body.apiKey, req.body.token);
  res.json({ success: true, data: result });
}

export async function confirmHandler(req: Request, res: Response) {
  const result = await websiteVerificationService.confirmWebsiteVisit(req.body.apiKey, req.body.token);
  res.json({ success: true, data: result });
}
