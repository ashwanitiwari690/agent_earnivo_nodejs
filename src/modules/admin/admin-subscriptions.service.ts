import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { createNotification } from '../notifications/notifications.service.js';
import { computePlanPrice, CYCLE_DAYS, PaidBillingCycle } from '../subscriptions/plan-pricing.js';
import { toMoneyString } from '../../utils/money.js';

// -- Plan management ---------------------------------------------------

export async function listPlans() {
  const plans = await prisma.subscriptionPlan.findMany({
    orderBy: { price: 'asc' },
    include: { _count: { select: { agentSubscriptions: { where: { status: 'ACTIVE' } } } } },
  });
  return plans.map((p) => ({ ...p, subscribersCount: p._count.agentSubscriptions, _count: undefined }));
}

export interface PlanInput {
  code: string;
  name: string;
  price: number;
  currency?: string;
  billingCycle: 'FREE' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  offerPercent?: number;
  campaignLimit: number;
  campaignDurationHours: number;
  isFreeTrial?: boolean;
  isActive?: boolean;
  features?: string[];
}

export async function createPlan(adminUserId: string, input: PlanInput) {
  const plan = await prisma.subscriptionPlan.create({ data: { ...input, features: input.features ?? [] } });
  await writeAuditLog({ userId: adminUserId, action: 'SUBSCRIPTION_PLAN_CREATED', entityType: 'subscription_plans', entityId: plan.id, metadata: { code: plan.code } });
  return plan;
}

export async function updatePlan(adminUserId: string, id: string, input: Partial<PlanInput>) {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id } });
  if (!plan) throw Errors.notFound('Subscription plan');
  const updated = await prisma.subscriptionPlan.update({ where: { id }, data: input });
  await writeAuditLog({
    userId: adminUserId,
    action: 'SUBSCRIPTION_PLAN_UPDATED',
    entityType: 'subscription_plans',
    entityId: updated.id,
    metadata: { code: updated.code, changed: Object.keys(input) },
  });
  return updated;
}

export async function setPlanStatus(adminUserId: string, id: string, isActive: boolean) {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id } });
  if (!plan) throw Errors.notFound('Subscription plan');
  const updated = await prisma.subscriptionPlan.update({ where: { id }, data: { isActive } });
  await writeAuditLog({ userId: adminUserId, action: 'SUBSCRIPTION_PLAN_UPDATED', entityType: 'subscription_plans', entityId: updated.id, metadata: { code: updated.code, isActive } });
  return updated;
}

// -- Agent subscriptions -------------------------------------------------

export async function listAgentSubscriptions(params: { page: number; pageSize: number; status?: string }) {
  const where = params.status ? { status: params.status as any } : {};
  const [rows, total] = await Promise.all([
    prisma.agentSubscription.findMany({
      where,
      include: { plan: true, agent: { select: { id: true, name: true, businessName: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.agentSubscription.count({ where }),
  ]);
  // amountPaid is a Prisma Decimal - stringified the same way
  // subscriptions.service.ts's getMySubscription/getMySubscriptionHistory
  // already do, so the Admin pages' Amount column can read it directly
  // instead of falling back to the plan's live (now cycle-flexible) price.
  const data = rows.map((r) => ({ ...r, amountPaid: r.amountPaid != null ? toMoneyString(r.amountPaid) : null }));
  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

// No payment gateway in Phase 2 (spec §12): this is the manual "admin
// confirms payment happened out-of-band" path. It supersedes whatever
// subscription the agent currently has active, and starts a fresh usage
// counter for the new billing period - trialUsed is never touched here,
// so a Free-trial agent who upgrades still can't fall back to a second
// free campaign later by downgrading again.
//
// `billingCycle`/`amountPaidOverride` let a caller that already knows the
// exact cycle+amount (payments.service.ts's approvePayment, from the
// approved Payment row) pass them through verbatim rather than have this
// function recompute them from the plan's *current* price/offer, which may
// have changed since the agent actually paid. Admin's own direct-activate
// path (no Payment row involved) has no such snapshot, so it defaults the
// cycle to MONTHLY and lets the amount be computed fresh here.
export async function activateForAgent(
  agentId: string,
  adminUserId: string,
  planCode: string,
  billingCycle?: PaidBillingCycle,
  amountPaidOverride?: number,
) {
  const [agent, plan] = await Promise.all([
    prisma.agentProfile.findUnique({ where: { id: agentId } }),
    prisma.subscriptionPlan.findUnique({ where: { code: planCode } }),
  ]);
  if (!agent) throw Errors.notFound('Agent');
  if (!plan || !plan.isActive) throw Errors.validation('Unknown or inactive plan.');

  // A Free Trial activation is never cycle-based (spec unchanged) - only a
  // paid plan (Starter/Professional today) has a real Weekly/Monthly/Yearly
  // choice, defaulting to Monthly when the caller doesn't specify one.
  const effectiveCycle: 'FREE' | PaidBillingCycle = plan.isFreeTrial ? 'FREE' : (billingCycle ?? 'MONTHLY');
  const expiresAt = effectiveCycle === 'FREE' ? null : new Date(Date.now() + CYCLE_DAYS[effectiveCycle] * 24 * 60 * 60 * 1000);
  const amountPaid = plan.isFreeTrial ? null : amountPaidOverride ?? computePlanPrice(plan, effectiveCycle as PaidBillingCycle).final;

  const [, , subscription] = await prisma.$transaction([
    prisma.agentSubscription.updateMany({
      where: { agentId, status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    }),
    prisma.subscriptionUsage.updateMany({
      where: { agentId },
      data: { campaignsCreated: 0, campaignsActive: 0, campaignsExpired: 0 },
    }),
    prisma.agentSubscription.create({
      data: {
        agentId,
        planId: plan.id,
        status: 'ACTIVE',
        isTrial: plan.isFreeTrial,
        billingCycle: effectiveCycle,
        amountPaid,
        startedAt: new Date(),
        expiresAt,
        activatedBy: adminUserId,
      },
      include: { plan: true },
    }),
  ]);

  await prisma.subscriptionUsage.updateMany({ where: { agentId }, data: { subscriptionId: subscription.id } });

  await writeAuditLog({
    userId: adminUserId,
    action: 'SUBSCRIPTION_ACTIVATED',
    entityType: 'agent_subscriptions',
    entityId: subscription.id,
    metadata: { agentId, plan: plan.code },
  });

  await createNotification({
    userId: agent.userId,
    type: 'SUBSCRIPTION_ACTIVATED',
    title: 'Subscription activated',
    message: `Your ${plan.name} subscription is now active.`,
    metadata: { subscriptionId: subscription.id, plan: plan.code },
  });

  return subscription;
}

export async function cancelForAgent(agentId: string, adminUserId: string) {
  const subscription = await prisma.agentSubscription.findFirst({ where: { agentId, status: 'ACTIVE' } });
  if (!subscription) throw Errors.notFound('Active subscription');

  const updated = await prisma.agentSubscription.update({ where: { id: subscription.id }, data: { status: 'CANCELLED' } });

  await writeAuditLog({
    userId: adminUserId,
    action: 'SUBSCRIPTION_CANCELLED',
    entityType: 'agent_subscriptions',
    entityId: subscription.id,
    metadata: { agentId },
  });

  return updated;
}
