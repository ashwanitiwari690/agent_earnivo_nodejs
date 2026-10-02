import { z } from 'zod';

export const createTicketSchema = z.object({
  category: z.enum(['ACCOUNT', 'PAYMENT', 'WITHDRAWAL', 'CAMPAIGN', 'REFERRAL', 'OTHER']),
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(5).max(3000),
});

export const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export const updateTicketAdminSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
  adminReply: z.string().trim().max(3000).optional(),
  assignedTo: z.string().uuid().optional(),
});
