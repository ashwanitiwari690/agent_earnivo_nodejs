import { Request, Response } from 'express';
import { listSurveyResponses } from './admin-surveys.service.js';

export async function listSurveyResponsesHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number; search?: string };
  const result = await listSurveyResponses(query);
  res.json({ success: true, ...result });
}
