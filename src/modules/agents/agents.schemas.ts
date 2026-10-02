import { z } from 'zod';

export const updateAgentSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  phone: z.string().trim().min(7).max(20).optional(),
  // Business contact email - a separate AgentProfile column from the
  // account's login email (User.email), so editing it here never touches
  // how the agent signs in.
  email: z.string().trim().toLowerCase().email().optional(),
  businessName: z.string().trim().max(200).optional(),
  businessType: z.string().trim().max(150).optional(),
  website: z.string().trim().max(300).optional().or(z.literal('')),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  taxId: z.string().trim().max(50).optional(),
  invoicePreference: z.enum(['email', 'download']).optional(),
  profileImage: z.string().trim().url().max(500).optional(),
});

export const changeAgentPasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(72),
});
