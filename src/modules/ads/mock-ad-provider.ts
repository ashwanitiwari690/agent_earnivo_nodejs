import { randomUUID } from 'node:crypto';
import type { AdProvider, AdTrackingEvent, NormalizedAd } from './ad-provider.interface.js';

// Spec Phase 13 §6: "Since there is currently no Google/Meta advertising
// account, create a TEST provider." Every ad it returns is explicitly
// marked `isTest: true` and titled "Test ..." so nothing downstream could
// mistake it for real ad revenue (spec §32: "Mock data must remain clearly
// separate from production data"). It never writes anything to AdEvent -
// there is no real campaign behind it to attribute an impression/click to,
// so trackImpression/trackClick are no-ops by design, not an oversight.
const MOCK_CREATIVES: Record<string, Omit<NormalizedAd, 'id' | 'provider' | 'placement' | 'trackingId'>> = {
  BANNER: {
    type: 'BANNER',
    title: 'Test Banner',
    description: 'This is a placeholder banner shown when no internal campaign is available.',
    banner: undefined,
    clickAction: 'NONE',
    priority: 0,
    isTest: true,
  },
  IMAGE: {
    type: 'IMAGE',
    title: 'Test Image',
    description: 'This is a placeholder image ad.',
    image: undefined,
    clickAction: 'NONE',
    priority: 0,
    isTest: true,
  },
  PROMOTIONAL: {
    type: 'PROMOTIONAL',
    title: 'Test Promotional Card',
    description: 'Earn more by completing tasks in the Earn tab.',
    clickAction: 'NONE',
    priority: 0,
    isTest: true,
  },
};

export class MockAdProvider implements AdProvider {
  readonly code = 'MOCK' as const;

  async initialize(): Promise<void> {}

  async getAd(placement: string, _userId: string | null): Promise<NormalizedAd | null> {
    const creative = MOCK_CREATIVES['BANNER']!;
    return {
      ...creative,
      id: `mock-${placement.toLowerCase()}`,
      provider: this.code,
      placement,
      trackingId: randomUUID(),
    };
  }

  async trackImpression(_event: AdTrackingEvent): Promise<void> {}
  async trackClick(_event: AdTrackingEvent): Promise<void> {}
  async dispose(): Promise<void> {}
}
