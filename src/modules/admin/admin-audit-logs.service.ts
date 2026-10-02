import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';

// Read-only listing over the AuditLog table every writeAuditLog() call site
// across the codebase already writes to - this is the first (and only)
// place anything reads it back. A null userId means the entry was written
// by a backend process acting on its own (e.g. a manual admin data
// correction script), not by a signed-in Admin/Agent/User - surfaced as
// role "System" rather than hidden.
export async function listAuditLogs(params: { page: number; pageSize: number; action?: string; entityType?: string; search?: string }) {
  const where: any = {
    ...(params.action ? { action: params.action } : {}),
    ...(params.entityType ? { entityType: params.entityType } : {}),
    ...(params.search
      ? {
          OR: [
            { action: { contains: params.search, mode: 'insensitive' } },
            { entityType: { contains: params.search, mode: 'insensitive' } },
            { user: { name: { contains: params.search, mode: 'insensitive' } } },
            { user: { email: { contains: params.search, mode: 'insensitive' } } },
            { user: { phone: { contains: params.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { name: true, email: true, phone: true, role: { select: { code: true } } } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  const data = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    // No anonymization here - unlike the referral masking convention, this
    // view is admin-only and the whole point is full traceability.
    user: r.user ? (r.user.name ?? r.user.email ?? r.user.phone ?? 'Unknown') : 'System',
    role: r.user?.role?.code ?? 'SYSTEM',
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata: r.metadata,
  }));

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

// Powers the Audit Logs page's "Action" filter dropdown with real values
// instead of a hardcoded guess at what actions exist - every distinct
// action string ever actually written, newest-used first isn't tracked, so
// alphabetical is the simplest stable order.
export async function listDistinctActions(): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } });
  return rows.map((r) => r.action);
}
