import { z } from 'zod';

export const updateCmsPageSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().max(50000).optional(),
  version: z.string().trim().max(20).optional(),
  isPublished: z.boolean().optional(),
});

export const faqInputSchema = z.object({
  question: z.string().trim().min(3).max(500),
  answer: z.string().trim().min(1).max(5000),
  category: z.string().trim().max(100).optional(),
  isPublished: z.boolean().default(true),
  displayOrder: z.coerce.number().int().default(0),
});

export const faqUpdateSchema = faqInputSchema.partial();

export const updateContactConfigSchema = z.object({
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional(),
  whatsapp: z.string().trim().max(20).optional(),
  address: z.string().trim().max(500).optional(),
  businessHours: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  facebookUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
  instagramUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
  twitterUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
});
