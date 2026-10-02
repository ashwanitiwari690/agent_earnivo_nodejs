import { Request, Response } from 'express';
import { getDashboardStats } from './admin-dashboard.service.js';

export async function getDashboardStatsHandler(_req: Request, res: Response) {
  const stats = await getDashboardStats();
  res.json({ success: true, data: stats });
}
