import cron from 'node-cron';
import { prisma } from '../db/prisma.js';
import { writeAuditLog } from '../modules/audit/audit.service.js';
import { createNotification } from '../modules/notifications/notifications.service.js';

// Mirrors expireCampaigns.job.ts's pattern (spec Phase 8 §9): a periodic
// backstop that writes the EXPIRED status to the row itself, rather than
// leaving expiry purely as something entitlement.service.ts computes on
// read. canCreateCampaign()/isSubscriptionActive() already treat a
// past-expiresAt ACTIVE row as not-active regardless of this job, so
// correctness never depended on it - this just keeps the stored status (and
// therefore admin dashboard counts, reports, and the agent's own "Current
// Plan" screen) accurate without anyone having to look at the row first.
export async function sweepExpiredSubscriptions() {
  const expired = await prisma.agentSubscription.findMany({
    where: { status: 'ACTIVE', expiresAt: { not: null, lte: new Date() } },
    select: { id: true, agentId: true, agent: { select: { userId: true } } },
  });

  for (const subscription of expired) {
    await prisma.agentSubscription.update({ where: { id: subscription.id }, data: { status: 'EXPIRED' } });
    await writeAuditLog({
      action: 'SUBSCRIPTION_EXPIRED',
      entityType: 'agent_subscriptions',
      entityId: subscription.id,
      metadata: { agentId: subscription.agentId, via: 'cron' },
    });
    await createNotification({
      userId: subscription.agent.userId,
      type: 'SUBSCRIPTION_EXPIRED',
      title: 'Subscription expired',
      message: 'Your subscription has expired. Renew or upgrade to keep creating campaigns.',
      metadata: { subscriptionId: subscription.id },
    });
  }

  if (expired.length) console.log(`[expireSubscriptions] expired ${expired.length} subscription(s)`);
}

// Separate, cheaper heads-up sweep (spec §11: "Subscription Expiring") - a
// single one-time notification when a subscription enters its final 24h,
// not a recurring reminder. Guarded by an idempotency marker in metadata
// isn't needed: the query window (expiresAt between now and now+24h) only
// ever matches a subscription once as it crosses that boundary between
// 5-minute runs, since expiresAt itself never changes.
export async function sweepExpiringSubscriptions() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const in24hPlusInterval = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 5 * 60 * 1000);

  const expiring = await prisma.agentSubscription.findMany({
    where: { status: 'ACTIVE', expiresAt: { gte: in24h, lt: in24hPlusInterval } },
    select: { id: true, agent: { select: { userId: true } } },
  });

  for (const subscription of expiring) {
    await createNotification({
      userId: subscription.agent.userId,
      type: 'SUBSCRIPTION_EXPIRING',
      title: 'Subscription expiring soon',
      message: 'Your subscription expires in about 24 hours. Renew to avoid interruption.',
      metadata: { subscriptionId: subscription.id },
    });
  }
}

export function startExpireSubscriptionsJob() {
  cron.schedule('*/5 * * * *', () => {
    sweepExpiredSubscriptions().catch((err) => console.error('[expireSubscriptions] failed', err));
    sweepExpiringSubscriptions().catch((err) => console.error('[expireSubscriptions] expiring-sweep failed', err));
  });
}
