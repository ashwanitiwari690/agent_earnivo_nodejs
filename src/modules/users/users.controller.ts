import { Request, Response } from 'express';
import * as usersService from './users.service.js';
import { getMyGameEarnings } from '../games/games.service.js';

export async function getMeHandler(req: Request, res: Response) {
  const user = await usersService.getMe(req.user!.id);
  res.json({ success: true, data: user });
}

export async function updateMeHandler(req: Request, res: Response) {
  const user = await usersService.updateMe(req.user!.id, req.body);
  res.json({ success: true, data: user });
}

export async function updateMyPayoutDefaultsHandler(req: Request, res: Response) {
  const result = await usersService.updateMyPayoutDefaults(req.user!.id, req.body);
  res.json({ success: true, data: result });
}

export async function updateMyNotificationPreferencesHandler(req: Request, res: Response) {
  const result = await usersService.updateMyNotificationPreferences(req.user!.id, req.body);
  res.json({ success: true, data: result });
}

export async function listMySessionsHandler(req: Request, res: Response) {
  const sessions = await usersService.listMySessions(req.user!.id);
  res.json({ success: true, data: sessions });
}

export async function revokeMySessionHandler(req: Request, res: Response) {
  await usersService.revokeMySession(req.user!.id, req.params.id as string);
  res.json({ success: true, data: { id: req.params.id } });
}

export async function getMyWalletHandler(req: Request, res: Response) {
  const wallet = await usersService.getMyWallet(req.user!.id);
  res.json({ success: true, data: wallet });
}

export async function getMyWalletTransactionsHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number };
  const result = await usersService.getMyWalletTransactions(req.user!.id, query);
  res.json({ success: true, ...result });
}

export async function getMyCampaignHistoryHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number; status?: string };
  const result = await usersService.getMyCampaignHistory(req.user!.id, query);
  res.json({ success: true, ...result });
}

export async function getMyEarningsHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number };
  const result = await usersService.getMyEarnings(req.user!.id, query);
  res.json({ success: true, ...result });
}

export async function getMyGameEarningsHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number };
  const result = await getMyGameEarnings(req.user!.id, query);
  res.json({ success: true, ...result });
}

export async function deleteMyAccountHandler(req: Request, res: Response) {
  await usersService.deleteMyAccount(req.user!.id);
  res.status(200).json({ success: true, data: { message: 'Your account has been permanently deleted.' } });
}

