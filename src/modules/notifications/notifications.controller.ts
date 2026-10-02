import { Request, Response } from 'express';
import { listMyNotifications, markAllNotificationsRead, markNotificationRead } from './notifications.service.js';
import { registerDeviceToken, unregisterDeviceToken } from './device-tokens.service.js';

export async function listMyNotificationsHandler(req: Request, res: Response) {
  const { page, pageSize } = req.validatedQuery;
  const result = await listMyNotifications(req.user!.id, { page, pageSize });
  res.json({ success: true, ...result });
}

export async function markReadHandler(req: Request, res: Response) {
  await markNotificationRead(req.user!.id, req.params.id as string);
  res.json({ success: true, data: { id: req.params.id } });
}

export async function markAllReadHandler(req: Request, res: Response) {
  await markAllNotificationsRead(req.user!.id);
  res.json({ success: true, data: { marked: true } });
}

export async function registerDeviceHandler(req: Request, res: Response) {
  await registerDeviceToken(req.user!.id, req.body);
  // The token is never echoed back: the client already has it, and keeping
  // it out of the response means it can't end up in a proxy log.
  res.json({ success: true, data: { registered: true } });
}

export async function unregisterDeviceHandler(req: Request, res: Response) {
  await unregisterDeviceToken(req.user!.id, req.body.token);
  res.json({ success: true, data: { unregistered: true } });
}
