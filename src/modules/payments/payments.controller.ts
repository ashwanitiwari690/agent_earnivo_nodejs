import { Request, Response } from 'express';
import { Errors } from '../../utils/AppError.js';
import { publicUploadUrl } from '../../middleware/upload.js';
import { approvePayment, listMyPayments, listPaymentsAdmin, rejectPayment, submitPayment } from './payments.service.js';

export async function submitPaymentHandler(req: Request, res: Response) {
  if (!req.file) throw Errors.validation('A payment screenshot is required.');
  const proofImageUrl = publicUploadUrl(req.file.filename);
  const payment = await submitPayment(req.user!.id, { ...req.body, proofImageUrl });
  res.status(201).json({ success: true, data: payment });
}

export async function listMyPaymentsHandler(req: Request, res: Response) {
  const { page, pageSize, status } = req.validatedQuery;
  const result = await listMyPayments(req.user!.id, { page, pageSize, status });
  res.json({ success: true, ...result });
}

export async function listPaymentsAdminHandler(req: Request, res: Response) {
  const { page, pageSize, status } = req.validatedQuery;
  const result = await listPaymentsAdmin({ page, pageSize, status });
  res.json({ success: true, ...result });
}

export async function approvePaymentHandler(req: Request, res: Response) {
  const payment = await approvePayment(req.params.id as string, req.user!.id, req.body.adminRemark);
  res.json({ success: true, data: payment });
}

export async function rejectPaymentHandler(req: Request, res: Response) {
  const payment = await rejectPayment(req.params.id as string, req.user!.id, req.body.adminRemark);
  res.json({ success: true, data: payment });
}
