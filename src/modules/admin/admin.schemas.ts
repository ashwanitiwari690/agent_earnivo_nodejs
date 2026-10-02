import { z } from 'zod';

export const rejectCampaignSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.string().optional(),
  q: z.string().trim().max(200).optional(),
  // Free strings here by design - the real whitelist against actual Prisma
  // column names lives in the service layer (utils/sorting.ts's
  // resolveSortField), which is what actually prevents SQL/column
  // injection. An unrecognized value here just falls back to the default
  // sort rather than failing validation.
  sortBy: z.string().trim().max(50).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

// Base has no .default()s so planUpdateSchema.partial() below leaves an
// omitted field genuinely absent instead of Zod filling in its default -
// otherwise a partial update like { price: 200 } would silently reset
// currency/isFreeTrial/isActive/features to their defaults on every save.
const planBaseSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(50),
  name: z.string().trim().min(2).max(100),
  // For a non-free-trial plan this is the WEEKLY base price - Monthly/
  // Yearly are computed from it (plan-pricing.ts), never stored/entered
  // separately.
  price: z.coerce.number().int().min(0),
  currency: z.string().trim().length(3),
  billingCycle: z.enum(['FREE', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  // Admin-set discount (0-100%) applied on top of the computed price for
  // every cycle of this plan. Meaningless for the Free Trial plan.
  offerPercent: z.coerce.number().int().min(0).max(100),
  campaignLimit: z.coerce.number().int().min(1),
  campaignDurationHours: z.coerce.number().int().min(1),
  isFreeTrial: z.boolean(),
  isActive: z.boolean(),
  features: z.array(z.string()),
});

export const planInputSchema = planBaseSchema.extend({
  currency: planBaseSchema.shape.currency.default('INR'),
  offerPercent: planBaseSchema.shape.offerPercent.default(0),
  isFreeTrial: planBaseSchema.shape.isFreeTrial.default(false),
  isActive: planBaseSchema.shape.isActive.default(true),
  features: planBaseSchema.shape.features.default([]),
});

export const planUpdateSchema = planBaseSchema.partial();

export const planStatusSchema = z.object({
  isActive: z.boolean(),
});

export const activateSubscriptionSchema = z.object({
  planCode: z.string().trim().toUpperCase().min(2).max(50),
  // Which cycle to activate a non-free-trial plan at (ignored for FREE,
  // defaults to MONTHLY when omitted - see admin-subscriptions.service.ts's
  // activateForAgent). Not accepted from a Payment-driven activation, which
  // always carries its own already-chosen cycle instead.
  billingCycle: z.enum(['WEEKLY', 'MONTHLY', 'YEARLY']).optional(),
});

export const adjustWalletSchema = z.object({
  // Negative debits, positive credits - one field, matching how the ledger
  // itself stores signed amounts (spec Phase 7 §13's WITHDRAWAL convention).
  amount: z.coerce.number().finite().refine((v) => v !== 0, 'Amount must not be zero.'),
  reason: z.string().trim().min(3, 'A reason is required.').max(500),
});

export const listSurveyResponsesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().max(200).optional(),
});

export const listTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  type: z.string().optional(),
  search: z.string().trim().max(200).optional(),
});

export const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  action: z.string().optional(),
  entityType: z.string().optional(),
  search: z.string().trim().max(200).optional(),
});

export const listParticipationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.string().optional(),
  campaignId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
});

export const setUserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

// Admin-created USER accounts skip the OTP verification real self-signup
// requires (user-auth.service.ts's verifyOtpAndAuthenticate) - the admin is
// vouching for this person directly, so the account is created
// phoneVerified/ACTIVE immediately. Phone is required (not optional, unlike
// the column itself) because it's the only credential a User account can
// ever sign in with - an admin-created row with no phone could never be
// logged into.
export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  phone: z.string().trim().min(7).max(20),
  email: z.string().trim().toLowerCase().email().optional(),
});

export const setAgentStatusSchema = z.object({
  status: z.enum(['PENDING', 'ACTIVE', 'INACTIVE', 'SUSPENDED']),
});

// Admin-created agent accounts skip the self-registration verification flow
// entirely (auth.service.ts's register()) - the admin is vouching for the
// agent directly, so the account is created ACTIVE/VERIFIED and can log in
// immediately with the password given here.
export const createAgentSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().min(7).max(20).optional(),
  password: z.string().min(8).max(72),
  businessName: z.string().trim().max(200).optional(),
  businessType: z.string().trim().max(150).optional(),
  website: z.string().trim().max(300).optional().or(z.literal('')),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  taxId: z.string().trim().max(50).optional(),
});

export const broadcastAnnouncementSchema = z.object({
  title: z.string().trim().min(3).max(200),
  message: z.string().trim().min(3).max(2000),
  target: z.enum(['ALL_USERS', 'ALL_AGENTS', 'ALL']),
});

export const setEnabledSchema = z.object({
  isEnabled: z.boolean(),
});

export const listGameConversionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  gameCode: z.string().trim().max(50).optional(),
  userId: z.string().uuid().optional(),
  status: z.enum(['COMPLETED', 'FAILED']).optional(),
});
