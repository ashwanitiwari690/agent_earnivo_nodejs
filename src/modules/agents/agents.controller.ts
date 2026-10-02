import { Request, Response } from 'express';
import * as agentsService from './agents.service.js';

export async function getMeHandler(req: Request, res: Response) {
  const agent = await agentsService.getMe(req.user!.id);
  res.json({ success: true, data: agent });
}

export async function updateMeHandler(req: Request, res: Response) {
  const agent = await agentsService.updateMe(req.user!.id, req.body);
  res.json({ success: true, data: agent });
}

export async function changePasswordHandler(req: Request, res: Response) {
  const result = await agentsService.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword);
  res.json({ success: true, data: result });
}

export async function getMyNotificationPreferencesHandler(req: Request, res: Response) {
  const prefs = await agentsService.getMyNotificationPreferences(req.user!.id);
  res.json({ success: true, data: prefs });
}
