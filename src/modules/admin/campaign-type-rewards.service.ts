import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { toMoneyString } from '../../utils/money.js';

// The User reward Admin configures per Campaign Type (Phase 5 update). Lives
// on the existing campaign_types table (see schema.prisma) rather than a
// separate config table - its `code` unique constraint already gives
// "one active reward config per type" for free.
export function listCampaignTypeRewards() {
  return prisma.campaignType.findMany({ orderBy: { name: 'asc' } });
}

export async function getCampaignTypeReward(code: string) {
  const type = await prisma.campaignType.findUnique({ where: { code } });
  if (!type) throw Errors.notFound('Campaign type');
  return type;
}

export async function updateCampaignTypeReward(
  adminUserId: string,
  code: string,
  input: { rewardAmount: number; currency?: string; isActive?: boolean; displayOrder?: number },
) {
  const existing = await prisma.campaignType.findUnique({ where: { code } });
  if (!existing) throw Errors.notFound('Campaign type');

  const updated = await prisma.campaignType.update({
    where: { code },
    data: {
      rewardAmount: input.rewardAmount,
      currency: input.currency ?? existing.currency,
      isActive: input.isActive ?? existing.isActive,
      displayOrder: input.displayOrder ?? existing.displayOrder,
      updatedBy: adminUserId,
    },
  });

  // Every already-created Task keeps the reward it was stamped with -
  // nothing here touches existing campaigns/tasks/completions, only future
  // ones (spec Phase 5 update §16).
  await writeAuditLog({
    userId: adminUserId,
    action: 'CAMPAIGN_TYPE_REWARD_UPDATED',
    entityType: 'campaign_types',
    entityId: existing.id,
    metadata: {
      campaignType: code,
      oldRewardAmount: toMoneyString(existing.rewardAmount),
      newRewardAmount: toMoneyString(updated.rewardAmount),
      oldIsActive: existing.isActive,
      newIsActive: updated.isActive,
    },
  });

  return updated;
}

export async function deleteCampaignTypeReward(adminUserId: string, code: string) {
  const existing = await prisma.campaignType.findUnique({ where: { code } });
  if (!existing) throw Errors.notFound('Campaign type');

  const campaignCount = await prisma.campaign.count({ where: { campaignTypeId: existing.id } });
  if (campaignCount > 0) {
    throw Errors.conflict(
      'CAMPAIGN_TYPE_IN_USE',
      'This campaign type cannot be deleted because it has already been used by one or more campaigns.',
    );
  }

  await prisma.campaignType.delete({ where: { code } });

  await writeAuditLog({
    userId: adminUserId,
    action: 'CAMPAIGN_TYPE_REWARD_DELETED',
    entityType: 'campaign_types',
    entityId: existing.id,
    metadata: {
      campaignType: code,
      name: existing.name,
    },
  });
}
