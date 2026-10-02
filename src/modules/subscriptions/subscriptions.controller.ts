import { Request, Response } from 'express';
import { getAgentProfileByUserId } from '../agents/agents.service.js';
import * as subscriptionsService from './subscriptions.service.js';
import { getSubscriptionForInvoice, renderInvoicePdf } from './invoice.service.js';

export async function listPlansHandler(_req: Request, res: Response) {
  const plans = await subscriptionsService.listActivePlans();
  res.json({ success: true, data: plans });
}

export async function myPlanHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const subscription = await subscriptionsService.getMySubscription(agent.id);
  res.json({ success: true, data: subscription });
}

export async function myUsageHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const usage = await subscriptionsService.getMyUsage(agent.id);
  res.json({ success: true, data: usage });
}

export async function mySubscriptionHistoryHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const history = await subscriptionsService.getMySubscriptionHistory(agent.id);
  res.json({ success: true, data: history });
}

export async function downloadMyInvoiceHandler(req: Request, res: Response) {
  const agent = await getAgentProfileByUserId(req.user!.id);
  const subscription = await getSubscriptionForInvoice(req.params.id as string, agent.id);
  const pdf = await renderInvoicePdf(subscription);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="admobility-invoice-${subscription.id.slice(0, 8)}.pdf"`);
  res.send(pdf);
}
