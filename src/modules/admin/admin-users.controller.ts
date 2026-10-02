import { Request, Response } from 'express';
import { createUser, getUserDetail, listUsers, setUserStatus } from './admin-users.service.js';

export async function listUsersHandler(req: Request, res: Response) {
  const { page, pageSize, status, q } = req.validatedQuery;
  const result = await listUsers({ page, pageSize, status, search: q });
  res.json({ success: true, ...result });
}

export async function createUserHandler(req: Request, res: Response) {
  const user = await createUser(req.user!.id, req.body);
  res.status(201).json({ success: true, data: user });
}

export async function getUserDetailHandler(req: Request, res: Response) {
  const user = await getUserDetail(req.params.id as string);
  res.json({ success: true, data: user });
}

export async function setUserStatusHandler(req: Request, res: Response) {
  const result = await setUserStatus(req.user!.id, req.params.id as string, req.body.status);
  res.json({ success: true, data: result });
}
