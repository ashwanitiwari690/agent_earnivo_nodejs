import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';

const DEFAULT_TITLES: Record<'ABOUT' | 'TERMS' | 'PRIVACY', string> = {
  ABOUT: 'About Us',
  TERMS: 'Terms & Conditions',
  PRIVACY: 'Privacy Policy',
};

function assertValidType(type: string): asserts type is 'ABOUT' | 'TERMS' | 'PRIVACY' {
  if (type !== 'ABOUT' && type !== 'TERMS' && type !== 'PRIVACY') {
    throw Errors.validation('Unknown page type. Expected ABOUT, TERMS, or PRIVACY.');
  }
}

// Auto-creates the row on first read, same "no special-cased not-configured-
// yet error" pattern as PlatformPaymentConfig/ReferralConfig - an admin who
// has never touched this page yet still gets a real, empty, editable row
// rather than a 404.
async function getOrCreatePage(type: string) {
  assertValidType(type);
  const existing = await prisma.cmsPage.findUnique({ where: { type } });
  if (existing) return existing;
  return prisma.cmsPage.create({ data: { type, title: DEFAULT_TITLES[type], content: '' } });
}

export async function getPublishedPage(type: string) {
  const page = await getOrCreatePage(type);
  if (!page.isPublished) throw Errors.notFound('Page');
  return page;
}

export async function getPageAdmin(type: string) {
  return getOrCreatePage(type);
}

export interface UpdateCmsPageInput {
  title?: string;
  content?: string;
  version?: string;
  isPublished?: boolean;
}

export async function updatePage(adminUserId: string, type: string, input: UpdateCmsPageInput) {
  const current = await getOrCreatePage(type);
  const wasPublished = current.isPublished;
  const willPublish = input.isPublished ?? wasPublished;

  const updated = await prisma.cmsPage.update({
    where: { id: current.id },
    data: {
      ...input,
      updatedBy: adminUserId,
      // Stamped the first time the page transitions into published, not
      // re-stamped on every subsequent edit - "publishedAt" means "when did
      // this first go live", not "when was it last saved".
      publishedAt: !wasPublished && willPublish ? new Date() : current.publishedAt,
    },
  });

  await writeAuditLog({
    userId: adminUserId,
    action: 'CMS_PAGE_UPDATED',
    entityType: 'cms_pages',
    entityId: updated.id,
    metadata: { type, version: updated.version, isPublished: updated.isPublished },
  });

  return updated;
}

// -- FAQ ---------------------------------------------------------------

export function listPublishedFaqs() {
  return prisma.faq.findMany({ where: { isPublished: true }, orderBy: { displayOrder: 'asc' } });
}

export function listFaqsAdmin() {
  return prisma.faq.findMany({ orderBy: { displayOrder: 'asc' } });
}

export interface FaqInput {
  question: string;
  answer: string;
  category?: string;
  isPublished?: boolean;
  displayOrder?: number;
}

export async function createFaq(adminUserId: string, input: FaqInput) {
  const faq = await prisma.faq.create({ data: { ...input, updatedBy: adminUserId } });
  await writeAuditLog({ userId: adminUserId, action: 'FAQ_CREATED', entityType: 'faqs', entityId: faq.id });
  return faq;
}

export async function updateFaq(adminUserId: string, id: string, input: Partial<FaqInput>) {
  const existing = await prisma.faq.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound('FAQ');
  const faq = await prisma.faq.update({ where: { id }, data: { ...input, updatedBy: adminUserId } });
  await writeAuditLog({ userId: adminUserId, action: 'FAQ_UPDATED', entityType: 'faqs', entityId: faq.id });
  return faq;
}

export async function deleteFaq(adminUserId: string, id: string) {
  const existing = await prisma.faq.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound('FAQ');
  await prisma.faq.delete({ where: { id } });
  await writeAuditLog({ userId: adminUserId, action: 'FAQ_DELETED', entityType: 'faqs', entityId: id });
}

// -- Contact -------------------------------------------------------------

async function getOrCreateContactConfig() {
  const existing = await prisma.contactConfig.findFirst();
  if (existing) return existing;
  return prisma.contactConfig.create({ data: {} });
}

export async function getContactConfig() {
  return getOrCreateContactConfig();
}

export interface UpdateContactConfigInput {
  email?: string;
  phone?: string;
  whatsapp?: string;
  address?: string;
  businessHours?: string;
  description?: string;
  facebookUrl?: string;
  instagramUrl?: string;
  twitterUrl?: string;
}

export async function updateContactConfig(adminUserId: string, input: UpdateContactConfigInput) {
  const current = await getOrCreateContactConfig();
  const updated = await prisma.contactConfig.update({ where: { id: current.id }, data: { ...input, updatedBy: adminUserId } });
  await writeAuditLog({ userId: adminUserId, action: 'CONTACT_CONFIG_UPDATED', entityType: 'contact_config', entityId: updated.id });
  return updated;
}
