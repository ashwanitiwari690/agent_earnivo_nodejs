import { Request, Response } from 'express';
import * as adminParticipations from './admin-participations.service.js';

export async function listParticipationsHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number; status?: string; campaignId?: string; userId?: string; search?: string };
  const result = await adminParticipations.listParticipations(query);
  res.json({ success: true, ...result });
}

export async function getParticipationDetailHandler(req: Request, res: Response) {
  const detail = await adminParticipations.getParticipationDetail(req.params.id as string);
  res.json({ success: true, data: detail });
}

export async function approveParticipationHandler(req: Request, res: Response) {
  const result = await adminParticipations.approveParticipation(req.user!.id, req.params.id as string);
  res.json({ success: true, data: result });
}

export async function rejectParticipationHandler(req: Request, res: Response) {
  const result = await adminParticipations.rejectParticipation(req.user!.id, req.params.id as string, req.body.reason);
  res.json({ success: true, data: result });
}
