import { Request, Response } from 'express';
import * as adminAdsService from './admin-ads.service.js';

export async function listPlacementsHandler(_req: Request, res: Response) {
  const placements = await adminAdsService.listPlacements();
  res.json({ success: true, data: placements });
}

export async function setPlacementEnabledHandler(req: Request, res: Response) {
  const placement = await adminAdsService.setPlacementEnabled(req.user!.id, req.params.code as string, req.body.isEnabled);
  res.json({ success: true, data: placement });
}

export async function listProvidersHandler(_req: Request, res: Response) {
  const providers = await adminAdsService.listProviders();
  res.json({ success: true, data: providers });
}

export async function setProviderEnabledHandler(req: Request, res: Response) {
  const provider = await adminAdsService.setProviderEnabled(req.user!.id, req.params.provider as string, req.body.isEnabled);
  res.json({ success: true, data: provider });
}

export async function getAdAnalyticsHandler(_req: Request, res: Response) {
  const analytics = await adminAdsService.getAdAnalytics();
  res.json({ success: true, data: analytics });
}
