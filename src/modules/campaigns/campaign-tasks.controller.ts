import { Request, Response } from 'express';
import { getAgentProfileByUserId } from '../agents/agents.service.js';
import * as campaignTasksService from './campaign-tasks.service.js';

export async function listTasksHandler(req: Request, res: Response) {
  const tasks = await campaignTasksService.listTasks(req.params.id as string);
  res.json({ success: true, data: tasks });
}

export async function createTaskHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const task = await campaignTasksService.createTask(agent.id, req.params.id as string, req.body);
  res.status(201).json({ success: true, data: task });
}

export async function updateTaskHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const task = await campaignTasksService.updateTask(agent.id, req.params.id as string, req.params.taskId as string, req.body);
  res.json({ success: true, data: task });
}

export async function removeTaskHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  await campaignTasksService.removeTask(agent.id, req.params.id as string, req.params.taskId as string);
  res.json({ success: true, data: null });
}
