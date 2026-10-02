import { prisma } from '../../db/prisma.js';
import { computePlanEntitlement, PaidBillingCycle } from './plan-pricing.js';

// The single reusable authority for "can this agent create a campaign right
// now, and why/why not". Every write path that touches a campaign (create,
// submit) calls canCreateCampaign() before touching the campaigns table -
// nothing about limits, trial status, or plan comes from the request.
//
// subscription_usage is one permanent row per agent (not per subscription).
// trial_used lives there and is the canonical flag: it is set exactly once,
// on first campaign submission under a free-trial plan, and nothing in this
// service ever clears it back to false. Renewing/upgrading to a new paid
// subscription resets campaignsCreated/campaignsActive/campaignsExpired for
// the new billing period (done by the admin-activation flow), but never
// touches trialUsed.

export async function getActiveSubscription(agentId: string) {
  return prisma.agentSubscription.findFirst({
    where: { agentId, status: 'ACTIVE' },
    orderBy: { startedAt: 'desc' },
    include: { plan: true },
  });
}

export async function getPlan(agentId: string) {
  const subscription = await getActiveSubscription(agentId);
  return subscription?.plan ?? null;
}

// SubscriptionPlan.campaignLimit/campaignDurationHours are stored as a
// WEEKLY base, the same convention plan-pricing.ts uses for price - a
// subscription actually purchased at a Monthly/Yearly cycle needs those
// numbers scaled by the same weeks multiplier used to charge for that
// cycle, or a paying customer would be stuck with the Weekly quota/duration
// despite paying 4x/52x more (see computePlanEntitlement). Free Trial, and
// any pre-existing subscription row with no recorded billingCycle (nullable
// - see schema.prisma), keep the plan's stored numbers as-is.
export function effectiveEntitlement(subscription: {
  billingCycle: string | null;
  plan: { campaignLimit: number; campaignDurationHours: number; isFreeTrial: boolean };
}): { campaignLimit: number; campaignDurationHours: number } {
  const { plan, billingCycle } = subscription;
  if (plan.isFreeTrial || !billingCycle || billingCycle === 'FREE') {
    return { campaignLimit: plan.campaignLimit, campaignDurationHours: plan.campaignDurationHours };
  }
  return computePlanEntitlement(plan, billingCycle as PaidBillingCycle);
}

export async function getCampaignUsage(agentId: string) {
  return prisma.subscriptionUsage.findUnique({ where: { agentId } });
}

export async function hasFreeTrialBeenUsed(agentId: string): Promise<boolean> {
  const usage = await getCampaignUsage(agentId);
  return usage?.trialUsed ?? false;
}

export async function isSubscriptionActive(agentId: string): Promise<boolean> {
  const subscription = await getActiveSubscription(agentId);
  if (!subscription) return false;
  if (subscription.status !== 'ACTIVE') return false;
  if (subscription.expiresAt && subscription.expiresAt <= new Date()) return false;
  return true;
}

export async function isSubscriptionExpired(agentId: string): Promise<boolean> {
  const subscription = await getActiveSubscription(agentId);
  if (!subscription) return false;
  return subscription.status === 'EXPIRED' || (!!subscription.expiresAt && subscription.expiresAt <= new Date());
}

export async function getRemainingCampaigns(agentId: string): Promise<number> {
  const [subscription, usage] = await Promise.all([getActiveSubscription(agentId), getCampaignUsage(agentId)]);
  if (!subscription) return 0;
  const { campaignLimit } = effectiveEntitlement(subscription);
  return Math.max(campaignLimit - (usage?.campaignsCreated ?? 0), 0);
}

export async function getCampaignDuration(agentId: string): Promise<number | null> {
  const subscription = await getActiveSubscription(agentId);
  if (!subscription) return null;
  return effectiveEntitlement(subscription).campaignDurationHours;
}

// Banner Ads (a BANNER_IMAGE campaign created through the dedicated Banner
// Ad flow, banner-ad-form.component.ts) is a Professional-plan feature, not
// something every plan gets - centralized here as one set rather than
// scattered plan.code checks, so extending it to another plan later only
// touches this line. The Angular agent app mirrors this same set (see
// banner-ads-access.util.ts) to hide the nav item/route for agents who
// don't qualify, but this check is what actually enforces it.
const BANNER_ADS_PLAN_CODES = new Set(['PROFESSIONAL']);

export async function canCreateBannerAd(agentId: string): Promise<{ allowed: boolean; message: string }> {
  const plan = await getPlan(agentId);
  if (!plan || !BANNER_ADS_PLAN_CODES.has(plan.code)) {
    return {
      allowed: false,
      message: 'Banner Ads are available on the Professional plan. Upgrade your subscription to create banner ads.',
    };
  }
  return { allowed: true, message: 'Banner Ads are available on your plan.' };
}

export interface EntitlementResult {
  allowed: boolean;
  plan: string | null;
  campaignLimit: number | null;
  campaignUsed: number;
  campaignRemaining: number;
  trialUsed: boolean;
  code?: string;
  message: string;
}

export async function canCreateCampaign(agentId: string): Promise<EntitlementResult> {
  const subscription = await getActiveSubscription(agentId);
  const usage = await getCampaignUsage(agentId);
  const trialUsed = usage?.trialUsed ?? false;
  const campaignUsed = usage?.campaignsCreated ?? 0;

  if (!subscription) {
    return {
      allowed: false,
      plan: null,
      campaignLimit: null,
      campaignUsed,
      campaignRemaining: 0,
      trialUsed,
      code: 'NO_ACTIVE_SUBSCRIPTION',
      message: 'No active subscription. Please choose a plan to create campaigns.',
    };
  }

  const plan = subscription.plan;
  const { campaignLimit } = effectiveEntitlement(subscription);
  const base = {
    plan: plan.code,
    campaignLimit,
    campaignUsed,
    trialUsed,
  };

  const expired = subscription.status !== 'ACTIVE' || (!!subscription.expiresAt && subscription.expiresAt <= new Date());
  if (expired) {
    return {
      ...base,
      allowed: false,
      campaignRemaining: 0,
      code: 'SUBSCRIPTION_EXPIRED',
      message: 'Your subscription has expired. Please renew or upgrade to create campaigns.',
    };
  }

  if (plan.isFreeTrial && trialUsed) {
    return {
      ...base,
      allowed: false,
      campaignRemaining: 0,
      code: 'FREE_TRIAL_CAMPAIGN_USED',
      message: 'Your free campaign trial has already been used. Please upgrade your subscription to create another campaign.',
    };
  }

  const campaignRemaining = Math.max(campaignLimit - campaignUsed, 0);
  if (campaignRemaining <= 0) {
    return {
      ...base,
      allowed: false,
      campaignRemaining: 0,
      code: 'CAMPAIGN_LIMIT_REACHED',
      message: `You've used all ${campaignLimit} campaign${campaignLimit === 1 ? '' : 's'} on your ${plan.name} plan. Upgrade your subscription to create more campaigns.`,
    };
  }

  return {
    ...base,
    allowed: true,
    campaignRemaining,
    message: 'You can create a new campaign.',
  };
}
