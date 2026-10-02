import { Request, Response } from 'express';
import { createAgent, getAgentDetail, listAgents, setAgentStatus } from './admin-agents.service.js';

export async function listAgentsHandler(req: Request, res: Response) {
  const { page, pageSize, status, q } = req.validatedQuery;
  const result = await listAgents({ page, pageSize, status, search: q });
  res.json({ success: true, ...result });
}

export async function createAgentHandler(req: Request, res: Response) {
  const agent = await createAgent(req.user!.id, req.body);
  res.status(201).json({ success: true, data: agent });
}

export async function getAgentDetailHandler(req: Request, res: Response) {
  const agent = await getAgentDetail(req.params.id as string);
  res.json({ success: true, data: agent });
}

export async function setAgentStatusHandler(req: Request, res: Response) {
  const result = await setAgentStatus(req.user!.id, req.params.id as string, req.body.status);
  res.json({ success: true, data: result });
}
