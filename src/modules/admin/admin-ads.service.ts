import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';

export function listPlacements() {
  return prisma.adPlacement.findMany({ orderBy: { code: 'asc' } });
}

export async function setPlacementEnabled(adminUserId: string, code: string, isEnabled: boolean) {
  const existing = await prisma.adPlacement.findUnique({ where: { code } });
  if (!existing) throw Errors.notFound('Ad placement');

  const updated = await prisma.adPlacement.update({ where: { code }, data: { isEnabled, updatedBy: adminUserId } });
  // ad_placements/ad_provider_config use human-readable string primary keys,
  // not UUIDs like every other audited entity - entityId stays null and the
  // identifier goes in metadata instead, rather than widening the shared
  // AuditLog.entityId column away from its UUID type for these two tables.
  await writeAuditLog({ userId: adminUserId, action: 'AD_PLACEMENT_UPDATED', entityType: 'ad_placements', metadata: { code, isEnabled } });
  return updated;
}

export function listProviders() {
  return prisma.adProviderConfig.findMany({ orderBy: { provider: 'asc' } });
}

export async function setProviderEnabled(adminUserId: string, provider: string, isEnabled: boolean) {
  const existing = await prisma.adProviderConfig.findUnique({ where: { provider: provider as any } });
  if (!existing) throw Errors.notFound('Ad provider');

  const updated = await prisma.adProviderConfig.update({ where: { provider: provider as any }, data: { isEnabled, updatedBy: adminUserId } });
  await writeAuditLog({ userId: adminUserId, action: 'AD_PROVIDER_UPDATED', entityType: 'ad_provider_config', metadata: { provider, isEnabled } });
  return updated;
}

// Internal-campaign-only analytics (spec §32) - impressions/clicks/CTR per
// ad-eligible campaign (placement IS NOT NULL). Never includes mock/test
// deliveries since those write no AdEvent rows at all.
export async function getAdAnalytics() {
  const campaigns = await prisma.campaign.findMany({
    where: { placement: { not: null } },
    select: { id: true, campaignName: true, placement: true, priority: true, status: true, agent: { select: { name: true, businessName: true } } },
  });
  if (campaigns.length === 0) return { campaigns: [] };

  const counts = await prisma.adEvent.groupBy({
    by: ['campaignId', 'type'],
    where: { campaignId: { in: campaigns.map((c) => c.id) } },
    _count: { _all: true },
  });

  const byCampaign = new Map<string, { impressions: number; clicks: number }>();
  for (const row of counts) {
    const bucket = byCampaign.get(row.campaignId) ?? { impressions: 0, clicks: 0 };
    if (row.type === 'IMPRESSION') bucket.impressions = row._count._all;
    else bucket.clicks = row._count._all;
    byCampaign.set(row.campaignId, bucket);
  }

  return {
    campaigns: campaigns.map((c) => {
      const stats = byCampaign.get(c.id) ?? { impressions: 0, clicks: 0 };
      return {
        id: c.id,
        campaignName: c.campaignName,
        placement: c.placement,
        priority: c.priority,
        status: c.status,
        agent: c.agent.businessName ?? c.agent.name,
        impressions: stats.impressions,
        clicks: stats.clicks,
        ctr: stats.impressions > 0 ? Number(((stats.clicks / stats.impressions) * 100).toFixed(2)) : 0,
      };
    }),
  };
}
