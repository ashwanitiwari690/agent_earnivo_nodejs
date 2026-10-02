import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { writeAuditLog } from '../audit/audit.service.js';

export async function getAgentProfileByUserId(userId: string) {
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw Errors.notFound('Agent profile');
  return agent;
}

export async function getMe(userId: string) {
  return getAgentProfileByUserId(userId);
}

export interface UpdateAgentInput {
  name?: string;
  phone?: string;
  email?: string;
  businessName?: string;
  businessType?: string;
  website?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  taxId?: string;
  invoicePreference?: 'email' | 'download';
  profileImage?: string;
}

export async function updateMe(userId: string, input: UpdateAgentInput) {
  const agent = await getAgentProfileByUserId(userId);
  return prisma.agentProfile.update({
    where: { id: agent.id },
    data: input,
  });
}

// notifyRewards/notifyCampaigns/notifyAccount live on User, not
// AgentProfile - the same three columns the Ionic USER-role flow already
// uses (users.service.ts::getMe/updateMyNotificationPreferences). Reused
// directly here rather than duplicating a second copy of these preferences
// on AgentProfile.
export async function getMyNotificationPreferences(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { notifyRewards: true, notifyCampaigns: true, notifyAccount: true },
  });
  return user;
}

// Distinct from auth.service.ts's forgotPassword/resetPassword: this is a
// logged-in agent changing their own known password, so it requires the
// current one instead of an emailed token. Revokes every other session the
// same way resetPassword does, so a stolen/expired session can't survive a
// password change.
export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw Errors.validation('Current password is incorrect.');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  await writeAuditLog({ userId, action: 'PASSWORD_CHANGED', entityType: 'users', entityId: userId });

  return { message: 'Password updated. Please sign in again.' };
}
