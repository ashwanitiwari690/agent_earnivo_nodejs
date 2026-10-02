import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { InternalCampaignProvider } from './internal-campaign-provider.js';
import { MockAdProvider } from './mock-ad-provider.js';
import type { AdProviderCode, NormalizedAd } from './ad-provider.interface.js';

const internalProvider = new InternalCampaignProvider();
const mockProvider = new MockAdProvider();

async function isProviderEnabled(provider: AdProviderCode): Promise<boolean> {
  const config = await prisma.adProviderConfig.findUnique({ where: { provider } });
  return config?.isEnabled ?? false;
}

// The one place that knows about providers at all (spec §2: "The Ionic
// application must not need to know which provider generated the
// content"). Priority order (spec §5): an active, eligible internal
// campaign always wins; the mock/test provider is a pure fallback for when
// no internal campaign is eligible for this placement right now.
export async function getPlacementContent(placement: string, userId: string | null): Promise<NormalizedAd | null> {
  const placementConfig = await prisma.adPlacement.findUnique({ where: { code: placement } });
  if (!placementConfig || !placementConfig.isEnabled) return null;

  if (await isProviderEnabled('INTERNAL')) {
    const ad = await internalProvider.getAd(placement, userId);
    if (ad) return ad;
  }

  if (await isProviderEnabled('MOCK')) {
    return mockProvider.getAd(placement, userId);
  }

  return null;
}

export interface TrackEventInput {
  trackingId: string;
  type: 'IMPRESSION' | 'CLICK';
  campaignId?: string;
  placement: string;
  provider: AdProviderCode;
}

// Mock ads have no real campaign behind them, so there is nothing
// authoritative to record - this is a deliberate no-op, not a gap (spec §6:
// "Do not send fake events to Google or Meta" extends to not fabricating
// internal analytics for test content either).
export async function trackEvent(userId: string | null, input: TrackEventInput): Promise<void> {
  if (input.provider !== 'INTERNAL') return;
  if (!input.campaignId) throw Errors.validation('campaignId is required for internal-campaign tracking.');

  const event = { trackingId: input.trackingId, campaignId: input.campaignId, userId, placement: input.placement };
  if (input.type === 'IMPRESSION') await internalProvider.trackImpression(event);
  else await internalProvider.trackClick(event);
}
