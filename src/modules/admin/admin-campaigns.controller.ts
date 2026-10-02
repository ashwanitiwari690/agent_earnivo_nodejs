import { Request, Response } from 'express';
import * as adminCampaigns from './admin-campaigns.service.js';

export async function listHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number; status?: string; q?: string; sortBy?: string; sortOrder?: string };
  const result = await adminCampaigns.listAll(query);
  res.json({ success: true, ...result });
}

export async function analyticsHandler(_req: Request, res: Response) {
  const analytics = await adminCampaigns.getPlatformAnalytics();
  res.json({ success: true, data: analytics });
}

export async function getByIdHandler(req: Request, res: Response) {
  const campaign = await adminCampaigns.getById(req.params.id as string);
  res.json({ success: true, data: campaign });
}

export async function approveHandler(req: Request, res: Response) {
  const campaign = await adminCampaigns.approve(req.user!.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}

export async function rejectHandler(req: Request, res: Response) {
  const campaign = await adminCampaigns.reject(req.user!.id, req.params.id as string, req.body.reason);
  res.json({ success: true, data: campaign });
}

export async function archiveHandler(req: Request, res: Response) {
  const campaign = await adminCampaigns.archive(req.user!.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}
