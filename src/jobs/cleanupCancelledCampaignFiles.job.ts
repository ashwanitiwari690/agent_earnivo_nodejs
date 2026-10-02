import { unlink } from 'node:fs/promises';
import cron from 'node-cron';
import { prisma } from '../db/prisma.js';
import { uploadedFilePath } from '../middleware/upload.js';
import { writeAuditLog } from '../modules/audit/audit.service.js';

// A CANCELLED campaign (campaigns.service.ts's stop()) never goes live
// again, so its uploaded creative and its participants' proof screenshots
// only ever sit in uploads/ taking up disk space from then on. This sweep
// deletes those files and clears the DB columns that pointed to them, so a
// later run only ever sees rows it hasn't already cleaned - the query itself
// (imageUrl/proofImageUrl not null) is what makes it idempotent, the same
// pattern expireCampaigns.job.ts uses via its `status: 'ACTIVE'` filter.
export async function sweepCancelledCampaignFiles() {
  const campaigns = await prisma.campaign.findMany({
    where: { status: 'CANCELLED', imageUrl: { not: null } },
    select: { id: true, imageUrl: true },
  });

  let deletedFiles = 0;
  for (const campaign of campaigns) {
    const filePath = campaign.imageUrl ? uploadedFilePath(campaign.imageUrl) : null;
    if (filePath) {
      await unlink(filePath).catch(() => {});
      deletedFiles += 1;
    }
    await prisma.campaign.update({ where: { id: campaign.id }, data: { imageUrl: null } });
  }

  // Proof screenshots users uploaded for this campaign's tasks (MANUAL
  // verification strategy) - queried off UserTaskCompletion.campaignId
  // directly rather than through Task, since the column is denormalized
  // there already.
  const completions = await prisma.userTaskCompletion.findMany({
    where: { proofImageUrl: { not: null }, campaign: { status: 'CANCELLED' } },
    select: { id: true, proofImageUrl: true },
  });

  for (const completion of completions) {
    const filePath = completion.proofImageUrl ? uploadedFilePath(completion.proofImageUrl) : null;
    if (filePath) {
      await unlink(filePath).catch(() => {});
      deletedFiles += 1;
    }
    await prisma.userTaskCompletion.update({ where: { id: completion.id }, data: { proofImageUrl: null } });
  }

  if (campaigns.length || completions.length) {
    await writeAuditLog({
      action: 'CANCELLED_CAMPAIGN_FILES_CLEANED',
      entityType: 'campaigns',
      metadata: {
        via: 'cron',
        campaignsCleaned: campaigns.length,
        taskProofsCleaned: completions.length,
        deletedFiles,
      },
    });
    console.log(
      `[cleanupCancelledCampaignFiles] removed ${deletedFiles} file(s) from ${campaigns.length} cancelled ` +
        `campaign(s) and ${completions.length} task proof(s)`,
    );
  }
}

export function startCleanupCancelledCampaignFilesJob() {
  // "Every 2 days" doesn't have its own node-cron field - `*/2` on the
  // day-of-month field is the idiomatic way to express it (runs at 03:00 on
  // the 1st, 3rd, 5th... of each month). Safe even if a run is missed or the
  // month boundary shortens one gap to a day, since the sweep only ever
  // touches rows it hasn't already cleared.
  cron.schedule('0 3 */2 * *', () => {
    sweepCancelledCampaignFiles().catch((err) => console.error('[cleanupCancelledCampaignFiles] failed', err));
  });
}
