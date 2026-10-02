import { Request, Response } from 'express';
import {
  completeWithdrawal,
  createWithdrawal,
  getAvailableBalance,
  listMyWithdrawals,
  listWithdrawalsAdmin,
  markProcessing,
  rejectWithdrawal,
} from './withdrawals.service.js';

export async function getAvailableBalanceHandler(req: Request, res: Response) {
  const result = await getAvailableBalance(req.user!.id);
  res.json({ success: true, data: result });
}

export async function createWithdrawalHandler(req: Request, res: Response) {
  const withdrawal = await createWithdrawal(req.user!.id, req.body);
  res.status(201).json({ success: true, data: withdrawal });
}

export async function listMyWithdrawalsHandler(req: Request, res: Response) {
  const { page, pageSize, status } = req.validatedQuery;
  const result = await listMyWithdrawals(req.user!.id, { page, pageSize, status });
  res.json({ success: true, ...result });
}

export async function listWithdrawalsAdminHandler(req: Request, res: Response) {
  const { page, pageSize, status } = req.validatedQuery;
  const result = await listWithdrawalsAdmin({ page, pageSize, status });
  res.json({ success: true, ...result });
}

export async function markProcessingHandler(req: Request, res: Response) {
  const withdrawal = await markProcessing(req.params.id as string, req.user!.id, req.body.adminRemark);
  res.json({ success: true, data: withdrawal });
}

export async function completeWithdrawalHandler(req: Request, res: Response) {
  const withdrawal = await completeWithdrawal(req.params.id as string, req.user!.id, req.body.adminRemark);
  res.json({ success: true, data: withdrawal });
}

export async function rejectWithdrawalHandler(req: Request, res: Response) {
  const withdrawal = await rejectWithdrawal(req.params.id as string, req.user!.id, req.body.adminRemark);
  res.json({ success: true, data: withdrawal });
}
