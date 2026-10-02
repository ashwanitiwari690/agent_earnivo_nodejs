import { Request, Response } from 'express';
import * as adminSubscriptions from './admin-subscriptions.service.js';
import { getSubscriptionForInvoice, renderInvoicePdf } from '../subscriptions/invoice.service.js';

export async function listPlansHandler(_req: Request, res: Response) {
  const plans = await adminSubscriptions.listPlans();
  res.json({ success: true, data: plans });
}

export async function createPlanHandler(req: Request, res: Response) {
  const plan = await adminSubscriptions.createPlan(req.user!.id, req.body);
  res.status(201).json({ success: true, data: plan });
}

export async function updatePlanHandler(req: Request, res: Response) {
  const plan = await adminSubscriptions.updatePlan(req.user!.id, req.params.id as string, req.body);
  res.json({ success: true, data: plan });
}

export async function setPlanStatusHandler(req: Request, res: Response) {
  const plan = await adminSubscriptions.setPlanStatus(req.user!.id, req.params.id as string, req.body.isActive);
  res.json({ success: true, data: plan });
}

export async function listAgentSubscriptionsHandler(req: Request, res: Response) {
  const query = req.validatedQuery as { page: number; pageSize: number; status?: string };
  const result = await adminSubscriptions.listAgentSubscriptions(query);
  res.json({ success: true, ...result });
}

export async function activateAgentSubscriptionHandler(req: Request, res: Response) {
  const subscription = await adminSubscriptions.activateForAgent(req.params.id as string, req.user!.id, req.body.planCode, req.body.billingCycle);
  res.json({ success: true, data: subscription });
}

export async function cancelAgentSubscriptionHandler(req: Request, res: Response) {
  const subscription = await adminSubscriptions.cancelForAgent(req.params.id as string, req.user!.id);
  res.json({ success: true, data: subscription });
}

export async function downloadAgentInvoiceHandler(req: Request, res: Response) {
  const subscription = await getSubscriptionForInvoice(req.params.id as string);
  const pdf = await renderInvoicePdf(subscription);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="admobility-invoice-${subscription.id.slice(0, 8)}.pdf"`);
  res.send(pdf);
}
