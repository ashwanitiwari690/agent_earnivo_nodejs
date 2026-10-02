import { prisma } from '../../db/prisma.js';
import { writeAuditLog } from '../audit/audit.service.js';

// Single-row config table (spec Phase 7 §11) - reused rather than a new row
// per "version", matching the same "one row is the whole config" pattern
// already used for CampaignType's per-type reward config. Auto-creates the
// row on first read so callers never have to special-case "not configured
// yet" as a distinct error.
async function getOrCreateConfig() {
  const existing = await prisma.platformPaymentConfig.findFirst();
  if (existing) return existing;
  return prisma.platformPaymentConfig.create({ data: {} });
}

export async function getPaymentConfig() {
  return getOrCreateConfig();
}

export interface UpdatePaymentConfigInput {
  qrImageUrl?: string | null;
  upiId?: string | null;
  receiverName?: string | null;
  instructions?: string | null;
  isEnabled?: boolean;
  minimumAmount?: number | null;
  supportedMethods?: string[];
  paymentNotes?: string | null;
}

export async function updatePaymentConfig(adminUserId: string, input: UpdatePaymentConfigInput) {
  const current = await getOrCreateConfig();
  const updated = await prisma.platformPaymentConfig.update({
    where: { id: current.id },
    data: { ...input, updatedBy: adminUserId },
  });

  await writeAuditLog({
    userId: adminUserId,
    action: 'PLATFORM_PAYMENT_CONFIG_UPDATED',
    entityType: 'platform_payment_config',
    entityId: updated.id,
    metadata: { upiId: updated.upiId, receiverName: updated.receiverName },
  });

  return updated;
}
