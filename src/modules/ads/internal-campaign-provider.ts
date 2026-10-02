import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import type { AdProvider, AdTrackingEvent, NormalizedAd } from './ad-provider.interface.js';

// Frequency control (spec §9: "Maximum displays per user ... the goal is
// smooth UX") - a per-user, per-campaign daily impression cap. Deliberately
// generous (not "aggressive ad behavior") and checked against AdEvent,
// which is the same table impression tracking writes to, so no separate
// counter can drift out of sync with it.
const MAX_IMPRESSIONS_PER_USER_PER_DAY = 10;

function resolveAdType(campaign: { videoUrl: string | null; imageUrl: string | null; campaignType: { code: string } }): NormalizedAd['type'] {
  if (campaign.videoUrl) return 'VIDEO';
  if (campaign.campaignType.code === 'BANNER_IMAGE') return 'BANNER';
  if (campaign.imageUrl) return 'IMAGE';
  return 'PROMOTIONAL';
}

// Reuses the exact Campaign table every Agent campaign already lives in
// (spec §4: "Existing Agent Campaign functionality should be reusable") -
// a campaign becomes ad-eligible by having `placement` set AND being a
// BANNER_IMAGE-type campaign (the Campaign Type Normalization spec merged
// the old BANNER/IMAGE codes into this one - see seed.ts). The placement
// field alone isn't a strong enough gate: it's a generic, always-visible
// optional field on every campaign type (task/social/survey included), so
// a YouTube/Instagram/Survey campaign that happens to have a placement
// selected must never show up in an ad slot meant for actual advertisement
// creatives - only a campaign the Agent explicitly created under the
// Banner / Image Promotion type should ever appear here.
export class InternalCampaignProvider implements AdProvider {
  readonly code = 'INTERNAL' as const;

  async initialize(): Promise<void> {}

  async getAd(placement: string, userId: string | null): Promise<NormalizedAd | null> {
    const now = new Date();
    const candidates = await prisma.campaign.findMany({
      where: {
        placement,
        status: 'ACTIVE',
        campaignType: { code: 'BANNER_IMAGE' },
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
      },
      orderBy: { priority: 'desc' },
      include: { campaignType: { select: { code: true } } },
      take: 20,
    });
    if (candidates.length === 0) return null;

    let eligible = candidates;
    if (userId) {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const impressionCounts = await prisma.adEvent.groupBy({
        by: ['campaignId'],
        where: { userId, type: 'IMPRESSION', createdAt: { gte: since }, campaignId: { in: candidates.map((c) => c.id) } },
        _count: { _all: true },
      });
      const overCap = new Set(impressionCounts.filter((row) => row._count._all >= MAX_IMPRESSIONS_PER_USER_PER_DAY).map((row) => row.campaignId));
      eligible = candidates.filter((c) => !overCap.has(c.id));
    }
    if (eligible.length === 0) return null;

    const campaign = eligible[0]!;
    return {
      id: campaign.id,
      type: resolveAdType(campaign),
      provider: this.code,
      title: campaign.campaignName,
      description: campaign.description ?? undefined,
      image: campaign.imageUrl ?? undefined,
      banner: campaign.campaignType.code === 'BANNER_IMAGE' ? (campaign.imageUrl ?? undefined) : undefined,
      destination: campaign.destinationUrl ?? undefined,
      clickAction: campaign.destinationUrl ? 'OPEN_URL' : 'NONE',
      campaignId: campaign.id,
      placement,
      priority: campaign.priority,
      startAt: campaign.startsAt?.toISOString(),
      endAt: campaign.expiresAt?.toISOString(),
      trackingId: randomUUID(),
    };
  }

  // Idempotent via AdEvent's @@unique([trackingId, type]) - a re-render that
  // replays the same tracking call for an already-delivered ad hits the
  // unique-constraint violation and is silently absorbed (spec §10: "do not
  // count the same event repeatedly because of frontend re-rendering").
  async trackImpression(event: AdTrackingEvent): Promise<void> {
    if (!event.campaignId) return;
    await prisma.adEvent
      .create({ data: { campaignId: event.campaignId, trackingId: event.trackingId, type: 'IMPRESSION', placement: event.placement, userId: event.userId } })
      .catch((err: any) => {
        if (err?.code !== 'P2002') throw err;
      });
  }

  async trackClick(event: AdTrackingEvent): Promise<void> {
    if (!event.campaignId) return;
    await prisma.adEvent
      .create({ data: { campaignId: event.campaignId, trackingId: event.trackingId, type: 'CLICK', placement: event.placement, userId: event.userId } })
      .catch((err: any) => {
        if (err?.code !== 'P2002') throw err;
      });
  }

  async dispose(): Promise<void> {}
}
