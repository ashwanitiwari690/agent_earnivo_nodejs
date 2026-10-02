import { Request, Response } from 'express';
import * as campaignFeedService from './campaign-feed.service.js';

export async function listFeedHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number; type?: string; sort: string; q?: string };
  const result = await campaignFeedService.listFeed(req.user!.id, query);
  res.json({ success: true, ...result });
}

export async function getFeedDetailHandler(req: Request, res: Response) {
  const campaign = await campaignFeedService.getFeedDetail(req.user!.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}
