import cron from 'node-cron';
import { prisma } from '../db/prisma.js';
import { writeAuditLog } from '../modules/audit/audit.service.js';
import { createNotification } from '../modules/notifications/notifications.service.js';

// Backstop for campaign expiry - campaigns.service.ts / admin-campaigns.service.ts
// also flip an individual campaign to EXPIRED the moment it's read past its
// expiresAt, so correctness never depends on this job having run. This just
// makes sure it happens even for campaigns nobody looks at.
export async function sweepExpiredCampaigns() {
  const expired = await prisma.campaign.findMany({
    where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
    select: { id: true, agentId: true, campaignName: true, agent: { select: { userId: true } } },
  });

  for (const campaign of expired) {
    await prisma.$transaction([
      prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'EXPIRED' } }),
      prisma.subscriptionUsage.updateMany({
        where: { agentId: campaign.agentId },
        data: { campaignsExpired: { increment: 1 }, campaignsActive: { decrement: 1 } },
      }),
    ]);
    await writeAuditLog({ action: 'CAMPAIGN_EXPIRED', entityType: 'campaigns', entityId: campaign.id, metadata: { via: 'cron' } });
    await createNotification({
      userId: campaign.agent.userId,
      type: 'CAMPAIGN_EXPIRED',
      title: 'Campaign expired',
      message: `Your campaign "${campaign.campaignName}" has expired.`,
      metadata: { campaignId: campaign.id },
    });
  }

  if (expired.length) console.log(`[expireCampaigns] expired ${expired.length} campaign(s)`);
}

export function startExpireCampaignsJob() {
  cron.schedule('*/5 * * * *', () => {
    sweepExpiredCampaigns().catch((err) => console.error('[expireCampaigns] failed', err));
  });
}
