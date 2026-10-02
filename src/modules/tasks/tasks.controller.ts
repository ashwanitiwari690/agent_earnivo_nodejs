import { Request, Response } from 'express';
import { Errors } from '../../utils/AppError.js';
import { publicUploadUrl } from '../../middleware/upload.js';
import * as tasksService from './tasks.service.js';

export async function startTaskHandler(req: Request, res: Response) {
  const result = await tasksService.startTask(req.user!.id, req.params.taskId as string, req.body.advertisingId);
  res.status(201).json({ success: true, data: result });
}

export async function getCompletionStatusHandler(req: Request, res: Response) {
  const result = await tasksService.getCompletionStatus(req.user!.id, req.params.completionId as string);
  res.json({ success: true, data: result });
}

export async function submitTaskHandler(req: Request, res: Response) {
  const result = await tasksService.submitTask(req.user!.id, req.params.completionId as string, req.body.data ?? {});
  res.json({ success: true, data: result });
}

export async function uploadTaskProofHandler(req: Request, res: Response) {
  if (!req.file) throw Errors.validation('A proof image is required.');
  const proofImageUrl = publicUploadUrl(req.file.filename);
  const result = await tasksService.uploadTaskProof(req.user!.id, req.params.completionId as string, proofImageUrl);
  res.json({ success: true, data: result });
}
