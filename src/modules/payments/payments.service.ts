import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { Errors } from '../../utils/AppError.js';
import { toMoneyString } from '../../utils/money.js';
import { getAgentProfileByUserId } from '../agents/agents.service.js';
import { activateForAgent } from '../admin/admin-subscriptions.service.js';
import { createNotification, notifyAdmins } from '../notifications/notifications.service.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { getPaymentConfig } from '../platform-settings/platform-settings.service.js';
import { computePlanPrice, PaidBillingCycle } from '../subscriptions/plan-pricing.js';

function serializePayment(payment: any) {
  return { ...payment, amount: toMoneyString(payment.amount) };
}

export interface SubmitPaymentInput {
  planId: string;
  billingCycle: PaidBillingCycle;
  paymentMethod: 'UPI' | 'BANK_TRANSFER' | 'OTHER';
  transactionReference: string;
  paymentDate: Date;
  proofImageUrl: string;
}

// Submitting a payment proof only ever creates a PENDING record (spec Phase
// 7 §8) - it never touches AgentSubscription/SubscriptionUsage itself.
// Nothing about the plan is activated until an admin explicitly approves
// (see approvePayment below), so uploading a screenshot can never itself
// grant access to anything.
export async function submitPayment(userId: string, input: SubmitPaymentInput) {
  const agent = await getAgentProfileByUserId(userId);
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: input.planId } });
  if (!plan || !plan.isActive) throw Errors.validation('Unknown or inactive plan.');
  if (plan.isFreeTrial) throw Errors.validation('The Free Trial plan does not require payment.');

  // Server-computed, never accepted from the client (see submitPaymentSchema's
  // comment) - the one authoritative amount for this plan+cycle right now,
  // including whatever offer is currently active.
  const amount = computePlanPrice(plan, input.billingCycle).final;

  // Manual QR payment can be switched off / given a minimum amount by an
  // admin (spec Phase 12 §3) without touching this service's business
  // logic - both are read from the same PlatformPaymentConfig row the
  // Agent's payment screen already displays.
  const config = await getPaymentConfig();
  if (!config.isEnabled) {
    throw Errors.validation('Payments are temporarily unavailable. Please try again later.');
  }
  if (config.minimumAmount != null && amount < Number(config.minimumAmount)) {
    throw Errors.validation(`Minimum payment amount is ₹${config.minimumAmount}.`);
  }

  // Mirrors withdrawals.service.ts's "one in-flight request at a time" rule
  // (spec Phase 11 §8: "Prevent duplicate payment proof submissions") - an
  // agent can't accidentally (or deliberately) stack several payment proofs
  // awaiting review at once.
  const existingPending = await prisma.payment.findFirst({ where: { agentId: agent.id, status: 'PENDING' } });
  if (existingPending) {
    throw Errors.conflict('PAYMENT_IN_PROGRESS', 'You already have a payment awaiting review.');
  }

  let payment;
  try {
    payment = await prisma.payment.create({
      data: {
        agentId: agent.id,
        planId: plan.id,
        amount,
        billingCycle: input.billingCycle,
        paymentMethod: input.paymentMethod,
        transactionReference: input.transactionReference,
        paymentDate: input.paymentDate,
        proofImageUrl: input.proofImageUrl,
        status: 'PENDING',
      },
      include: { plan: true },
    });
  } catch (err: any) {
    // Prisma maps a Postgres unique_violation on a known model to its own
    // P2002 (unlike the raw driver code a CHECK constraint surfaces as -
    // see admin-wallet.service.ts). Since the hand-written partial index
    // guarding transaction_reference (spec Phase 12 §7: "Prevent duplicate
    // transaction ID") isn't declared in schema.prisma, Prisma can't
    // populate meta.target for it - but it's the only unique constraint on
    // Payment besides its primary key, so P2002 + modelName is unambiguous.
    if (err?.code === 'P2002' && err?.meta?.modelName === 'Payment') {
      throw Errors.conflict('DUPLICATE_TRANSACTION_REFERENCE', 'This transaction ID has already been submitted.');
    }
    throw err;
  }

  await createNotification({
    userId,
    type: 'PAYMENT_SUBMITTED',
    title: 'Payment submitted',
    message: `Your payment proof for the ${plan.name} plan was submitted and is pending review.`,
    metadata: { paymentId: payment.id, planCode: plan.code },
  });

  await notifyAdmins({
    type: 'NEW_PAYMENT',
    title: 'New payment awaiting review',
    message: `${agent.name} submitted a payment of ₹${amount} for the ${plan.name} plan.`,
    metadata: { paymentId: payment.id, agentId: agent.id },
  });

  return serializePayment(payment);
}

export async function listMyPayments(userId: string, params: { page: number; pageSize: number; status?: string }) {
  const agent = await getAgentProfileByUserId(userId);
  const where = { agentId: agent.id, ...(params.status ? { status: params.status as any } : {}) };
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: { plan: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.payment.count({ where }),
  ]);
  return { data: rows.map(serializePayment), page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export async function listPaymentsAdmin(params: { page: number; pageSize: number; status?: string }) {
  const where = params.status ? { status: params.status as any } : {};
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        agent: { select: { id: true, name: true, businessName: true, email: true, phone: true } },
        plan: { select: { code: true, name: true } },
        verifiedByUser: { select: { id: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.payment.count({ where }),
  ]);
  return { data: rows.map(serializePayment), page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

async function getPaymentOrThrow(id: string) {
  const payment = await prisma.payment.findUnique({ where: { id }, include: { agent: true, plan: true } });
  if (!payment) throw Errors.notFound('Payment');
  return payment;
}

export async function approvePayment(paymentId: string, adminUserId: string, adminRemark?: string) {
  const payment = await getPaymentOrThrow(paymentId);
  if (payment.status !== 'PENDING') throw Errors.conflict('PAYMENT_ALREADY_REVIEWED', 'This payment has already been reviewed.');

  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: { status: 'APPROVED', adminRemark, verifiedBy: adminUserId, verifiedAt: new Date() },
    include: { plan: true },
  });

  // Reuses the one existing subscription-activation code path (spec Phase 7
  // §9 step 3: "Activate subscription") rather than duplicating its
  // cancel-current / reset-usage / create-new / audit-log logic here. The
  // cycle and amount are this payment's own - what the agent actually paid
  // for, not whatever the plan's price/offer happen to be right now.
  await activateForAgent(
    payment.agentId,
    adminUserId,
    payment.plan.code,
    (payment.billingCycle ?? undefined) as PaidBillingCycle | undefined,
    Number(payment.amount),
  );

  await writeAuditLog({
    userId: adminUserId,
    action: 'PAYMENT_APPROVED',
    entityType: 'payments',
    entityId: paymentId,
    metadata: { agentId: payment.agentId, planCode: payment.plan.code, amount: toMoneyString(payment.amount) },
  });

  await createNotification({
    userId: payment.agent.userId,
    type: 'PAYMENT_APPROVED',
    title: 'Payment approved',
    message: `Your payment for the ${payment.plan.name} plan was approved. Your subscription is now active.`,
    metadata: { paymentId },
  });

  return serializePayment(updated);
}

export async function rejectPayment(paymentId: string, adminUserId: string, adminRemark: string) {
  const payment = await getPaymentOrThrow(paymentId);
  if (payment.status !== 'PENDING') throw Errors.conflict('PAYMENT_ALREADY_REVIEWED', 'This payment has already been reviewed.');

  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: { status: 'REJECTED', adminRemark, verifiedBy: adminUserId, verifiedAt: new Date() },
    include: { plan: true },
  });

  await writeAuditLog({
    userId: adminUserId,
    action: 'PAYMENT_REJECTED',
    entityType: 'payments',
    entityId: paymentId,
    metadata: { agentId: payment.agentId, reason: adminRemark },
  });

  await createNotification({
    userId: payment.agent.userId,
    type: 'PAYMENT_REJECTED',
    title: 'Payment rejected',
    message: `Your payment for the ${payment.plan.name} plan was rejected: ${adminRemark}`,
    metadata: { paymentId },
  });

  return serializePayment(updated);
}
