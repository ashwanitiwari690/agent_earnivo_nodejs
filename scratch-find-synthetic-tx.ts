import { prisma } from './src/db/prisma.js';
async function main() {
  const referrer = await prisma.user.findUnique({ where: { phone: '8447993958' } });
  const txs = await prisma.walletTransaction.findMany({ where: { userId: referrer!.id, referenceType: 'REFERRAL_REWARD' }, orderBy: { createdAt: 'desc' } });
  console.log(txs);
  // orphan check: does the referenced referral row still exist?
  for (const t of txs) {
    const ref = await prisma.referral.findUnique({ where: { id: t.referenceId! } });
    console.log(t.id, 'referral exists:', !!ref);
  }
}
main().then(() => process.exit(0));
