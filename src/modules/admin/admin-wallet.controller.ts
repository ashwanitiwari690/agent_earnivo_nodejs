import { Request, Response } from 'express';
import { adjustUserWallet, getWalletOverview, listTransactions } from './admin-wallet.service.js';

export async function adjustWalletHandler(req: Request, res: Response) {
  const { amount, reason } = req.body;
  const result = await adjustUserWallet(req.user!.id, req.params.userId as string, amount, reason);
  res.json({ success: true, data: result });
}

export async function listTransactionsHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number; type?: string; search?: string };
  const result = await listTransactions(query);
  res.json({ success: true, ...result });
}

export async function getWalletOverviewHandler(_req: Request, res: Response) {
  const overview = await getWalletOverview();
  res.json({ success: true, data: overview });
}
