import { Request, Response } from 'express';
import * as cmsService from './cms.service.js';

export async function getPublishedPageHandler(req: Request, res: Response) {
  const type = req.params.type as string;
  const page = await cmsService.getPublishedPage(type);
  res.json({ success: true, data: page });
}

export async function getPageAdminHandler(req: Request, res: Response) {
  const type = req.params.type as string;
  const page = await cmsService.getPageAdmin(type);
  res.json({ success: true, data: page });
}

export async function updatePageHandler(req: Request, res: Response) {
  const type = req.params.type as string;
  const page = await cmsService.updatePage(req.user!.id, type, req.body);
  res.json({ success: true, data: page });
}

export async function listPublishedFaqsHandler(_req: Request, res: Response) {
  const faqs = await cmsService.listPublishedFaqs();
  res.json({ success: true, data: faqs });
}

export async function listFaqsAdminHandler(_req: Request, res: Response) {
  const faqs = await cmsService.listFaqsAdmin();
  res.json({ success: true, data: faqs });
}

export async function createFaqHandler(req: Request, res: Response) {
  const faq = await cmsService.createFaq(req.user!.id, req.body);
  res.status(201).json({ success: true, data: faq });
}

export async function updateFaqHandler(req: Request, res: Response) {
  const faq = await cmsService.updateFaq(req.user!.id, req.params.id as string, req.body);
  res.json({ success: true, data: faq });
}

export async function deleteFaqHandler(req: Request, res: Response) {
  await cmsService.deleteFaq(req.user!.id, req.params.id as string);
  res.json({ success: true, data: { deleted: true } });
}

export async function getContactConfigHandler(_req: Request, res: Response) {
  const config = await cmsService.getContactConfig();
  res.json({ success: true, data: config });
}

export async function updateContactConfigHandler(req: Request, res: Response) {
  const config = await cmsService.updateContactConfig(req.user!.id, req.body);
  res.json({ success: true, data: config });
}
