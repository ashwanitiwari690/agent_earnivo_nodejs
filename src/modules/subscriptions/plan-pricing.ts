// Single source of truth for turning a plan's stored weekly base price
// (SubscriptionPlan.price, for any non-free-trial plan) into what a
// specific billing cycle actually costs. Every backend call site that
// needs a Weekly/Monthly/Yearly amount goes through this - the Free Trial
// plan never does (its price is always the flat, stored 0).
export type PaidBillingCycle = 'WEEKLY' | 'MONTHLY' | 'YEARLY';

// Monthly is 4 weeks, not a calendar month, so the numbers stay simple and
// easy for an agent to mentally verify against the weekly price; Yearly is
// the full 52 weeks. Kept in lockstep with CYCLE_DAYS below (used for
// subscription expiry), which uses the same weeks-based reasoning in days.
const CYCLE_WEEKS: Record<PaidBillingCycle, number> = { WEEKLY: 1, MONTHLY: 4, YEARLY: 52 };
export const CYCLE_DAYS: Record<PaidBillingCycle, number> = { WEEKLY: 7, MONTHLY: 30, YEARLY: 365 };

export interface PlanPrice {
  // The plain weeks x price amount, before any offer discount.
  original: number;
  // What is actually charged, after `plan.offerPercent` is applied. Equal
  // to `original` whenever there's no active offer.
  final: number;
}

// Rounds to the nearest whole rupee - `SubscriptionPlan.price` is already a
// whole-rupee Int, and there is no reason to charge paise here.
export function computePlanPrice(plan: { price: number; offerPercent: number }, cycle: PaidBillingCycle): PlanPrice {
  const original = plan.price * CYCLE_WEEKS[cycle];
  const final = Math.round((original * (100 - plan.offerPercent)) / 100);
  return { original, final };
}

export interface PlanEntitlement {
  campaignLimit: number;
  campaignDurationHours: number;
}

// SubscriptionPlan.campaignLimit/campaignDurationHours are stored as the
// same WEEKLY base as price (an admin only ever enters one number per
// plan), so they need the exact same weeks-multiplier scaling computePlanPrice
// applies - otherwise a Monthly/Yearly subscriber would pay 4x/52x more but
// be stuck with the Weekly campaign quota and per-campaign runtime, which is
// what the plans page used to do before this existed. Free Trial is never
// cycle-flexible (see computePlanPrice's own callers) and keeps its stored
// numbers as-is.
export function computePlanEntitlement(plan: { campaignLimit: number; campaignDurationHours: number }, cycle: PaidBillingCycle): PlanEntitlement {
  const weeks = CYCLE_WEEKS[cycle];
  return { campaignLimit: plan.campaignLimit * weeks, campaignDurationHours: plan.campaignDurationHours * weeks };
}
