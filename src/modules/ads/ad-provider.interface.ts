// The AdProvider abstraction (spec Phase 13 §16). Ionic never sees which of
// these produced a given ad - it only ever gets back a NormalizedAd from
// GET /ads/placements/:placement. Implemented today: InternalCampaignProvider
// and MockAdProvider. GoogleMobileAdProvider/MetaAdProvider are intentionally
// NOT implemented (spec §14/§15: "do not implement production integrations
// unless explicitly requested") - AdProviderCode already reserves their slot
// in the schema/admin UI so adding them later is additive, not a rewrite.
export type AdProviderCode = 'INTERNAL' | 'MOCK' | 'GOOGLE' | 'META';

// Matches spec Phase 13 §3 exactly. Every field is optional except the ones
// that are always meaningful (id/type/provider/placement/trackingId) -
// a BANNER ad has no `title`, a text card has no `image`, etc.
export interface NormalizedAd {
  id: string;
  type: 'IMAGE' | 'BANNER' | 'PROMOTIONAL' | 'VIDEO' | 'CARD';
  provider: AdProviderCode;
  title?: string;
  description?: string;
  image?: string;
  banner?: string;
  destination?: string;
  clickAction: 'OPEN_URL' | 'NONE';
  campaignId?: string;
  placement: string;
  priority: number;
  startAt?: string;
  endAt?: string;
  trackingId: string;
  isTest?: boolean;
}

export interface AdTrackingEvent {
  trackingId: string;
  campaignId: string | null;
  userId: string | null;
  placement: string;
}

export interface AdProvider {
  readonly code: AdProviderCode;
  initialize(): Promise<void>;
  getAd(placement: string, userId: string | null): Promise<NormalizedAd | null>;
  trackImpression(event: AdTrackingEvent): Promise<void>;
  trackClick(event: AdTrackingEvent): Promise<void>;
  dispose(): Promise<void>;
}
