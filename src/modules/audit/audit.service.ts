import { prisma } from '../../db/prisma.js';
import type { Prisma } from '../../../generated/prisma/client.js';

interface WriteAuditLogInput {
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export function writeAuditLog(input: WriteAuditLogInput) {
  return prisma.auditLog.create({
    data: {
      userId: input.userId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}
