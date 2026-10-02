import { prisma } from '../../db/prisma.js';
import * as entitlement from './entitlement.service.js';
import { computePlanEntitlement, computePlanPrice, PaidBillingCycle } from './plan-pricing.js';
import { toMoneyString } from '../../utils/money.js';

const PAID_CYCLES: PaidBillingCycle[] = ['WEEKLY', 'MONTHLY', 'YEARLY'];

// The Free Trial plan is returned exactly as stored (one flat, one-time
// price). Every other plan's stored row is the WEEKLY base - expanded here
// into all 3 cycle variants so neither Angular app has to reimplement the
// pricing formula: the Agent's plan picker just filters this array by
// `billingCycle`, and Submit Payment's amount always comes from whichever
// variant the agent picked, never a client-side computation.
export async function listActivePlans() {
  const plans = await prisma.subscriptionPlan.findMany({ where: { isActive: true }, orderBy: { price: 'asc' } });
  return plans.flatMap((plan) => {
    if (plan.isFreeTrial) return [{ ...plan, originalPrice: null as number | null }];
    return PAID_CYCLES.map((cycle) => {
      const { original, final } = computePlanPrice(plan, cycle);
      const { campaignLimit, campaignDurationHours } = computePlanEntitlement(plan, cycle);
      return {
        ...plan,
        billingCycle: cycle as typeof plan.billingCycle,
        price: final,
        originalPrice: (plan.offerPercent > 0 ? original : null) as number | null,
        campaignLimit,
        campaignDurationHours,
      };
    });
  });
}

export async function getMySubscription(agentId: string) {
  const subscription = await entitlement.getActiveSubscription(agentId);
  if (!subscription) return null;
  return {
    id: subscription.id,
    plan: subscription.plan,
    status: subscription.status,
    isTrial: subscription.isTrial,
    // The cycle/amount this specific subscription period was actually
    // activated/paid at (nullable only for rows created before this
    // feature existed - see schema.prisma) - shown instead of live
    // plan.price/billingCycle, which no longer describes a single fixed
    // price once Starter/Professional are cycle-flexible.
    billingCycle: subscription.billingCycle,
    amountPaid: subscription.amountPaid != null ? toMoneyString(subscription.amountPaid) : null,
    startedAt: subscription.startedAt,
    expiresAt: subscription.expiresAt,
  };
}

export function getMyUsage(agentId: string) {
  return entitlement.canCreateCampaign(agentId);
}

// Every subscription row this agent has ever had (ACTIVE, CANCELLED,
// EXPIRED) - getMySubscription() above only ever surfaces the current one,
// which is all campaign-creation checks need, but the Agent Settings
// "Subscription History" page needs the full timeline.
export async function getMySubscriptionHistory(agentId: string) {
  const rows = await prisma.agentSubscription.findMany({
    where: { agentId },
    include: { plan: true },
    orderBy: { startedAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    plan: r.plan,
    status: r.status,
    isTrial: r.isTrial,
    // See getMySubscription's matching fields above - a price snapshot of
    // what this period actually cost, not live plan.price.
    billingCycle: r.billingCycle,
    amountPaid: r.amountPaid != null ? toMoneyString(r.amountPaid) : null,
    startedAt: r.startedAt,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}
