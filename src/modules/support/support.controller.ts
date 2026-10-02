import { Request, Response } from 'express';
import * as supportService from './support.service.js';

export async function createTicketHandler(req: Request, res: Response) {
  const ticket = await supportService.createTicket(req.user!.id, req.body);
  res.status(201).json({ success: true, data: ticket });
}

export async function listMyTicketsHandler(req: Request, res: Response) {
  const { page, pageSize, status } = req.validatedQuery;
  const result = await supportService.listMyTickets(req.user!.id, { page, pageSize, status });
  res.json({ success: true, ...result });
}

export async function getMyTicketHandler(req: Request, res: Response) {
  const ticket = await supportService.getMyTicket(req.user!.id, req.params.id as string);
  res.json({ success: true, data: ticket });
}

export async function listTicketsAdminHandler(req: Request, res: Response) {
  const { page, pageSize, status, q } = req.validatedQuery;
  const result = await supportService.listTicketsAdmin({ page, pageSize, status, search: q });
  res.json({ success: true, ...result });
}

export async function updateTicketAdminHandler(req: Request, res: Response) {
  const ticket = await supportService.updateTicketAdmin(req.user!.id, req.params.id as string, req.body);
  res.json({ success: true, data: ticket });
}
