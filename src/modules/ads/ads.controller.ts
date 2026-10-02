import { Request, Response } from 'express';
import * as adsService from './ads.service.js';

export async function getPlacementHandler(req: Request, res: Response) {
  const ad = await adsService.getPlacementContent(req.params.placement as string, req.user?.id ?? null);
  res.json({ success: true, data: ad });
}

export async function trackEventHandler(req: Request, res: Response) {
  await adsService.trackEvent(req.user?.id ?? null, req.body);
  res.json({ success: true, data: { tracked: true } });
}
