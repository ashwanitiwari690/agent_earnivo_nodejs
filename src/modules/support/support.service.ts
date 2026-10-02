import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { Errors } from '../../utils/AppError.js';
import { createNotification } from '../notifications/notifications.service.js';
import { writeAuditLog } from '../audit/audit.service.js';

export interface CreateTicketInput {
  category: string;
  subject: string;
  message: string;
}

// Works identically for USER and AGENT reporters - both are User rows
// already (spec Phase 11 §9's flow doesn't distinguish them).
export async function createTicket(userId: string, input: CreateTicketInput) {
  const ticket = await prisma.supportTicket.create({ data: { userId, ...input } });
  await writeAuditLog({ userId, action: 'SUPPORT_TICKET_CREATED', entityType: 'support_tickets', entityId: ticket.id });
  return ticket;
}

export async function listMyTickets(userId: string, params: { page: number; pageSize: number; status?: string }) {
  const where = { userId, ...(params.status ? { status: params.status as any } : {}) };
  const [data, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.supportTicket.count({ where }),
  ]);
  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export async function getMyTicket(userId: string, id: string) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id } });
  if (!ticket || ticket.userId !== userId) throw Errors.notFound('Support ticket');
  return ticket;
}

export async function listTicketsAdmin(params: { page: number; pageSize: number; status?: string; search?: string }) {
  const where = {
    ...(params.status ? { status: params.status as any } : {}),
    ...(params.search
      ? {
          OR: [
            { subject: { contains: params.search, mode: 'insensitive' as const } },
            { user: { name: { contains: params.search, mode: 'insensitive' as const } } },
            { user: { phone: { contains: params.search } } },
            { user: { email: { contains: params.search, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      include: { user: { select: { id: true, name: true, phone: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.supportTicket.count({ where }),
  ]);
  return { data: rows, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export interface UpdateTicketAdminInput {
  status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  adminReply?: string;
  assignedTo?: string;
}

export async function updateTicketAdmin(adminUserId: string, id: string, input: UpdateTicketAdminInput) {
  const existing = await prisma.supportTicket.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound('Support ticket');

  const ticket = await prisma.supportTicket.update({
    where: { id },
    data: {
      ...input,
      resolvedAt: input.status === 'RESOLVED' || input.status === 'CLOSED' ? new Date() : existing.resolvedAt,
    },
  });

  await writeAuditLog({
    userId: adminUserId,
    action: 'SUPPORT_TICKET_UPDATED',
    entityType: 'support_tickets',
    entityId: id,
    metadata: { status: ticket.status },
  });

  if (input.status && input.status !== existing.status) {
    await createNotification({
      userId: ticket.userId,
      type: 'SUPPORT_TICKET_UPDATED',
      title: 'Support ticket updated',
      message: `Your ticket "${ticket.subject}" is now ${ticket.status.replace('_', ' ').toLowerCase()}.`,
      metadata: { ticketId: id },
    });
  }

  return ticket;
}
