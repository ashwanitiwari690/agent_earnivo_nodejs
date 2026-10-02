import { prisma } from '../../db/prisma.js';
import { paginationMeta } from '../../utils/pagination.js';
import { toMoneyString } from '../../utils/money.js';
import { Errors } from '../../utils/AppError.js';
import { hashPassword } from '../../utils/password.js';
import { createNotification } from '../notifications/notifications.service.js';
import { writeAuditLog } from '../audit/audit.service.js';

export async function listAgents(params: { page: number; pageSize: number; search?: string; status?: string }) {
  const where = {
    ...(params.status ? { status: params.status as any } : {}),
    ...(params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: 'insensitive' as const } },
            { email: { contains: params.search, mode: 'insensitive' as const } },
            { businessName: { contains: params.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.agentProfile.findMany({
      where,
      select: {
        id: true, name: true, email: true, phone: true, businessName: true, status: true, verificationStatus: true, createdAt: true,
        subscriptions: { where: { status: 'ACTIVE' }, select: { plan: { select: { name: true } }, expiresAt: true }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.agentProfile.count({ where }),
  ]);

  const data = rows.map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    phone: a.phone,
    businessName: a.businessName,
    status: a.status,
    verificationStatus: a.verificationStatus,
    createdAt: a.createdAt,
    currentPlan: a.subscriptions[0]?.plan.name ?? null,
    subscriptionExpiresAt: a.subscriptions[0]?.expiresAt ?? null,
  }));

  return { data, page: params.page, pageSize: params.pageSize, total, pagination: paginationMeta(params.page, params.pageSize, total) };
}

export async function getAgentDetail(id: string) {
  const agent = await prisma.agentProfile.findUnique({
    where: { id },
    include: {
      subscriptions: { where: { status: 'ACTIVE' }, include: { plan: true }, take: 1 },
      usage: true,
    },
  });
  if (!agent) throw Errors.notFound('Agent');

  const [campaigns, recentPayments] = await Promise.all([
    prisma.campaign.groupBy({ by: ['status'], where: { agentId: id }, _count: { _all: true } }),
    prisma.payment.findMany({ where: { agentId: id }, include: { plan: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  const campaignsByStatus: Record<string, number> = {};
  for (const row of campaigns) campaignsByStatus[row.status] = row._count._all;

  return {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    phone: agent.phone,
    businessName: agent.businessName,
    profileImage: agent.profileImage,
    status: agent.status,
    verificationStatus: agent.verificationStatus,
    createdAt: agent.createdAt,
    subscription: agent.subscriptions[0]
      ? { plan: agent.subscriptions[0].plan.name, status: agent.subscriptions[0].status, expiresAt: agent.subscriptions[0].expiresAt }
      : null,
    usage: agent.usage
      ? { campaignsCreated: agent.usage.campaignsCreated, campaignsActive: agent.usage.campaignsActive, campaignsExpired: agent.usage.campaignsExpired }
      : null,
    campaignsByStatus,
    recentPayments: recentPayments.map((p) => ({ id: p.id, plan: p.plan.name, amount: toMoneyString(p.amount), status: p.status, createdAt: p.createdAt })),
  };
}

export async function setAgentStatus(adminUserId: string, id: string, status: 'PENDING' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED') {
  const agent = await prisma.agentProfile.findUnique({ where: { id }, select: { id: true, userId: true } });
  if (!agent) throw Errors.notFound('Agent');

  // AgentProfile.status alone is only a business-facing label - the actual
  // login gate auth.service.ts's login() checks is User.status. Without also
  // flipping that here, "Suspend" in the admin panel would be purely
  // cosmetic and a blocked agent could keep signing in and using the API.
  // Outstanding refresh tokens are revoked on suspend for the same reason
  // change/resetPassword already do (see auth.service.ts's resetPassword).
  const userStatus = status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';

  const updated = await prisma.$transaction(async (tx) => {
    const agentProfile = await tx.agentProfile.update({ where: { id }, data: { status } });
    await tx.user.update({ where: { id: agent.userId }, data: { status: userStatus } });
    if (status === 'SUSPENDED') {
      await tx.refreshToken.updateMany({ where: { userId: agent.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return agentProfile;
  });

  await writeAuditLog({
    userId: adminUserId,
    action: 'AGENT_STATUS_CHANGED',
    entityType: 'agent_profiles',
    entityId: id,
    metadata: { status },
  });

  await createNotification({
    userId: agent.userId,
    type: status === 'ACTIVE' ? 'ACCOUNT_ACTIVATED' : status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_STATUS_CHANGED',
    title: 'Account status updated',
    message: `Your agent account status is now ${status}.`,
    metadata: {},
  });

  return { id: updated.id, status: updated.status };
}

// Mirrors auth.service.ts's register(), minus every verification step: the
// admin is vouching for this agent directly, so there is no email-
// verification token or WhatsApp OTP, the User is created
// emailVerified/phoneVerified, and the AgentProfile is created
// ACTIVE/VERIFIED rather than PENDING/UNVERIFIED - the agent can sign in
// with the given password immediately (login()'s phoneVerified gate would
// otherwise block them forever, since nothing here ever sends them an OTP
// to verify).
export async function createAgent(
  adminUserId: string,
  input: {
    name: string;
    email: string;
    phone?: string;
    password: string;
    businessName?: string;
    businessType?: string;
    website?: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    taxId?: string;
  },
) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists.');

  const [agentRole, freePlan] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { code: 'AGENT' } }),
    prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } }),
  ]);
  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        phone: input.phone,
        passwordHash,
        roleId: agentRole.id,
        emailVerified: true,
        phoneVerified: true,
      },
    });

    const agentProfile = await tx.agentProfile.create({
      data: {
        userId: user.id,
        name: input.name,
        email: input.email,
        phone: input.phone,
        businessName: input.businessName,
        businessType: input.businessType,
        website: input.website || undefined,
        address: input.address,
        city: input.city,
        state: input.state,
        country: input.country,
        taxId: input.taxId,
        status: 'ACTIVE',
        verificationStatus: 'VERIFIED',
      },
    });

    const subscription = await tx.agentSubscription.create({
      data: {
        agentId: agentProfile.id,
        planId: freePlan.id,
        status: 'ACTIVE',
        isTrial: true,
        trialUsed: false,
        startedAt: new Date(),
      },
    });

    await tx.subscriptionUsage.create({
      data: {
        agentId: agentProfile.id,
        subscriptionId: subscription.id,
        trialUsed: false,
      },
    });

    return { user, agentProfile };
  });

  await writeAuditLog({
    userId: adminUserId,
    action: 'AGENT_CREATED_BY_ADMIN',
    entityType: 'agent_profiles',
    entityId: result.agentProfile.id,
    metadata: { email: input.email },
  });

  await createNotification({
    userId: result.user.id,
    type: 'ACCOUNT_ACTIVATED',
    title: 'Your agent account is ready',
    message: 'An administrator created your agent account. You can sign in with the email and password provided to you.',
    metadata: {},
  });

  return {
    id: result.agentProfile.id,
    name: result.agentProfile.name,
    email: result.agentProfile.email,
    status: result.agentProfile.status,
  };
}
