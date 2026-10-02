import { Request, Response } from 'express';
import { broadcastAnnouncement } from './notifications.service.js';

export async function broadcastAnnouncementHandler(req: Request, res: Response) {
  const result = await broadcastAnnouncement(req.body);
  res.json({ success: true, data: result });
}
