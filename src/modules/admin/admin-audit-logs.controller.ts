import { Request, Response } from 'express';
import * as auditLogsService from './admin-audit-logs.service.js';

export async function listAuditLogsHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number; action?: string; entityType?: string; search?: string };
  const result = await auditLogsService.listAuditLogs(query);
  res.json({ success: true, ...result });
}

export async function listAuditLogActionsHandler(_req: Request, res: Response) {
  const actions = await auditLogsService.listDistinctActions();
  res.json({ success: true, data: actions });
}
