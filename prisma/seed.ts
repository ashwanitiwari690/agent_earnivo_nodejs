import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const ROLES = [
  { code: 'USER', name: 'User' },
  { code: 'AGENT', name: 'Agent' },
  { code: 'ADMIN', name: 'Admin' },
];

const CAMPAIGN_TYPES = [
  { code: 'APP_PROMOTION', name: 'App Promotion' },
  { code: 'BANNER_IMAGE', name: 'Banner / Image Promotion' },
  { code: 'FACEBOOK_PAGE_LIKE', name: 'Facebook Page Follow/Like' },
  { code: 'FACEBOOK_PROMOTION', name: 'Facebook Promotion' },
  { code: 'INSTAGRAM_FOLLOW', name: 'Instagram Follow' },
  { code: 'PRODUCT_PROMOTION', name: 'Product Promotion' },
  { code: 'SURVEY', name: 'Survey' },
  { code: 'TASK', name: 'Task' },
  { code: 'VIDEO', name: 'Video Promotion' },
  { code: 'WEBSITE_PROMOTION', name: 'Website Promotion' },
  { code: 'YOUTUBE_PROMOTION', name: 'YouTube Promotion / Subscribe' },
  { code: 'YOUTUBE_SUBSCRIBE', name: 'YouTube Subscribe (Verified)' },
];

const DEPRECATED_CAMPAIGN_TYPES = [
  { code: 'BANNER', name: 'Banner' },
  { code: 'IMAGE', name: 'Image' },
  { code: 'INSTAGRAM_PROMOTION', name: 'Instagram Promotion' },
];


const GAMES = [
  { code: 'ROAD_RUSH', name: 'Road Rush', coinsPerConversion: 1000, rupeesPerConversion: 10 },
  { code: 'BRAIN_RUSH', name: 'Brain Rush', coinsPerConversion: 1000, rupeesPerConversion: 10 },
  { code: 'MONSTER_ESCAPE', name: 'Monster Escape', coinsPerConversion: 1000, rupeesPerConversion: 10 },
  { code: 'TIC_RUSH', name: 'Tick Rush', coinsPerConversion: 1000, rupeesPerConversion: 10 },
];

const SUBSCRIPTION_PLANS = [
  {
    code: 'FREE',
    name: 'Free Trial',
    price: 0,
    currency: 'INR',
    billingCycle: 'FREE' as const,
    campaignLimit: 1,
    campaignDurationHours: 24,
    isFreeTrial: true,
    isActive: true,
    features: ['One-time 24-hour campaign trial', '1 campaign total, ever'],
  },
  {
    code: 'STARTER',
    name: 'Starter',
    price: 300,
    currency: 'INR',
    billingCycle: 'WEEKLY' as const,
    offerPercent: 0,
    campaignLimit: 10,
    campaignDurationHours: 168,
    isFreeTrial: false,
    isActive: true,
    features: ['Up to 10 active campaigns', '7-day campaign duration', 'Standard support'],
  },
  {
    code: 'PROFESSIONAL',
    name: 'Professional',
    price: 600,
    currency: 'INR',
    billingCycle: 'WEEKLY' as const,
    offerPercent: 0,
    campaignLimit: 50,
    campaignDurationHours: 720,
    isFreeTrial: false,
    isActive: true,
    features: ['Up to 50 active campaigns', '30-day campaign duration', 'Priority support', 'Banner Ads'],
  },
];

const AD_PLACEMENTS = [
  // { code: 'HOME_BANNER', name: 'Home Banner', description: 'Top banner on the Home tab.' },
  { code: 'HOME_CARD', name: 'Home Card', description: 'Promotional card in the Home tab feed.' },
  { code: 'TASK_BANNER', name: 'Task Banner', description: 'Banner above the task/campaign feed.' },
  { code: 'TASK_BOTTOM', name: 'Task Bottom', description: 'Slot below a task/campaign detail.' },
  { code: 'GAME_BANNER', name: 'Game Banner', description: 'Banner on a game screen (future).' },
  { code: 'GAME_REWARD', name: 'Game Reward', description: 'Rewarded-ad slot on a game screen (future).' },
  { code: 'BETWEEN_CONTENT', name: 'Between Content', description: 'Native slot interleaved between content lists.' },
];

const AD_PROVIDERS: { provider: 'INTERNAL' | 'MOCK' | 'GOOGLE' | 'META'; isEnabled: boolean }[] = [
  { provider: 'INTERNAL', isEnabled: true },
  { provider: 'MOCK', isEnabled: true },
  { provider: 'GOOGLE', isEnabled: false },
  { provider: 'META', isEnabled: false },
];

async function main() {
  for (const role of ROLES) {
    await prisma.role.upsert({ where: { code: role.code }, update: { name: role.name }, create: role });
  }

  for (const type of CAMPAIGN_TYPES) {
    await prisma.campaignType.upsert({ where: { code: type.code }, update: { name: type.name, isActive: true }, create: type });
  }

  for (const type of DEPRECATED_CAMPAIGN_TYPES) {
    await prisma.campaignType.upsert({ where: { code: type.code }, update: { isActive: false }, create: { ...type, isActive: false } });
  }

  for (const plan of SUBSCRIPTION_PLANS) {
    await prisma.subscriptionPlan.upsert({ where: { code: plan.code }, update: plan, create: plan });
  }

  for (const game of GAMES) {
    await prisma.game.upsert({ where: { code: game.code }, update: {}, create: game });
  }

  for (const placement of AD_PLACEMENTS) {
    await prisma.adPlacement.upsert({ where: { code: placement.code }, update: {}, create: placement });
  }

  for (const providerConfig of AD_PROVIDERS) {
    await prisma.adProviderConfig.upsert({
      where: { provider: providerConfig.provider },
      update: {},
      create: providerConfig,
    });
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
  const adminPasswordHash = await bcrypt.hash('Admin@!1234', 12);
  await prisma.user.upsert({
    where: { email: 'admin@admobility.in' },
    update: { emailVerified: true, phoneVerified: true },
    create: {
      email: 'admin@admobility.in',
      passwordHash: adminPasswordHash,
      roleId: adminRole.id,
      status: 'ACTIVE',
      emailVerified: true,
      phoneVerified: true,
    },
  });

  console.log(
    `Seed complete: ${ROLES.length} roles, ${CAMPAIGN_TYPES.length} campaign types (+${DEPRECATED_CAMPAIGN_TYPES.length} deprecated), ` +
      `${SUBSCRIPTION_PLANS.length} subscription plans, ${GAMES.length} games, ${AD_PLACEMENTS.length} ad placements, ` +
      `${AD_PROVIDERS.length} ad providers, 1 admin user.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
