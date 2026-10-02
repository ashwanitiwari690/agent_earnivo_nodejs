import { Request, Response } from 'express';
import * as campaignTypeRewardsService from './campaign-type-rewards.service.js';

export async function listHandler(_req: Request, res: Response) {
  const types = await campaignTypeRewardsService.listCampaignTypeRewards();
  res.json({ success: true, data: types });
}

export async function getByCodeHandler(req: Request, res: Response) {
  const type = await campaignTypeRewardsService.getCampaignTypeReward(req.params.code as string);
  res.json({ success: true, data: type });
}

export async function updateHandler(req: Request, res: Response) {
  const type = await campaignTypeRewardsService.updateCampaignTypeReward(req.user!.id, req.params.code as string, req.body);
  res.json({ success: true, data: type });
}

export async function deleteHandler(req: Request, res: Response) {
  await campaignTypeRewardsService.deleteCampaignTypeReward(req.user!.id, req.params.code as string);
  res.json({ success: true, data: null });
}
