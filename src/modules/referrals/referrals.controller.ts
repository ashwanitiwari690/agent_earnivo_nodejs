import { Request, Response } from 'express';
import { Errors } from '../../utils/AppError.js';
import {
  getMyReferralHistory,
  getMyReferralSummary,
  getReferralAnalyticsAdmin,
  getReferralConfig,
  listReferralsAdmin,
  updateReferralConfig,
  validateReferralCode,
} from './referrals.service.js';

export async function validateReferralCodeHandler(req: Request, res: Response) {
  const code = String(req.params.code ?? '').trim();
  if (!code) throw Errors.validation('A referral code is required.');
  const result = await validateReferralCode(code);
  res.json({ success: true, data: result });
}

export async function getMySummaryHandler(req: Request, res: Response) {
  const summary = await getMyReferralSummary(req.user!.id);
  res.json({ success: true, data: summary });
}

export async function getMyHistoryHandler(req: Request, res: Response) {
  const { page, pageSize } = req.validatedQuery;
  const result = await getMyReferralHistory(req.user!.id, { page, pageSize });
  res.json({ success: true, ...result });
}

export async function listReferralsAdminHandler(req: Request, res: Response) {
  const { page, pageSize, status } = req.validatedQuery;
  const result = await listReferralsAdmin({ page, pageSize, status });
  res.json({ success: true, ...result });
}

export async function getAnalyticsAdminHandler(_req: Request, res: Response) {
  const analytics = await getReferralAnalyticsAdmin();
  res.json({ success: true, data: analytics });
}

export async function getConfigHandler(_req: Request, res: Response) {
  const config = await getReferralConfig();
  res.json({ success: true, data: config });
}

export async function updateConfigHandler(req: Request, res: Response) {
  const config = await updateReferralConfig(req.user!.id, req.body);
  res.json({ success: true, data: config });
}
