import { Request, Response } from 'express';
import { getAgentProfileByUserId } from '../agents/agents.service.js';
import { Errors } from '../../utils/AppError.js';
import { publicUploadUrl } from '../../middleware/upload.js';
import * as campaignsService from './campaigns.service.js';

export async function listTypesHandler(_req: Request, res: Response) {
  const types = await campaignsService.listCampaignTypes();
  res.json({ success: true, data: types });
}

export async function listPlacementsHandler(_req: Request, res: Response) {
  const placements = await campaignsService.listEnabledPlacements();
  res.json({ success: true, data: placements });
}

export async function createHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const campaign = await campaignsService.createDraft(agent.id, req.body, req.user!.id);
  res.status(201).json({ success: true, data: campaign });
}

export async function listHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const query = req.validatedQuery as { page: number; pageSize: number; status?: string; q?: string; bannerAds?: 'only' | 'exclude' };
  const result = await campaignsService.listMine(agent.id, query);
  res.json({ success: true, ...result });
}

export async function analyticsHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const analytics = await campaignsService.getMyAnalytics(agent.id);
  res.json({ success: true, data: analytics });
}

export async function listMyParticipationsHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const query = req.validatedQuery as { page: number; pageSize: number; status?: string; campaignId?: string; search?: string };
  const result = await campaignsService.listMyParticipations(agent.id, query);
  res.json({ success: true, ...result });
}

export async function taskPerformanceHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const performance = await campaignsService.getMyTaskPerformance(agent.id);
  res.json({ success: true, data: performance });
}

export async function getByIdHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const campaign = await campaignsService.getMine(agent.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}

export async function updateHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const campaign = await campaignsService.updateDraft(agent.id, req.params.id as string, req.body);
  res.json({ success: true, data: campaign });
}

export async function removeHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  await campaignsService.removeDraft(agent.id, req.params.id as string);
  res.json({ success: true, data: null });
}

export async function submitHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const campaign = await campaignsService.submit(agent.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}

export async function uploadCreativeImageHandler(req: Request, res: Response) {
  if (!req.file) throw Errors.validation('An image file is required.');
  const agent = await getAgentProfileByUserId(req.user!.id);
  const imageUrl = publicUploadUrl(req.file.filename);
  const campaign = await campaignsService.setCreativeImage(agent.id, req.params.id as string, imageUrl, req.file.path);
  res.json({ success: true, data: campaign });
}

export async function regenerateAppVerificationApiKeyHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const campaign = await campaignsService.regenerateAppVerificationApiKey(agent.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}

export async function regenerateWebsiteVerificationApiKeyHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const campaign = await campaignsService.regenerateWebsiteVerificationApiKey(agent.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}

export async function activateHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const campaign = await campaignsService.activate(req.user!.id, agent.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}

export async function pauseHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const campaign = await campaignsService.pause(req.user!.id, agent.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}

export async function stopHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const campaign = await campaignsService.stop(req.user!.id, agent.id, req.params.id as string);
  res.json({ success: true, data: campaign });
}
