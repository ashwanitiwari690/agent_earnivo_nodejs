-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('FREE', 'MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED', 'PENDING');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CreativeType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "business_name" TEXT,
    "profile_image" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'PENDING',
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "billing_cycle" "BillingCycle" NOT NULL,
    "campaign_limit" INTEGER NOT NULL,
    "campaign_duration_hours" INTEGER NOT NULL,
    "is_free_trial" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "features" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_subscriptions" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "is_trial" BOOLEAN NOT NULL DEFAULT false,
    "trial_used" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "activated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_usage" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "subscription_id" UUID,
    "campaigns_created" INTEGER NOT NULL DEFAULT 0,
    "campaigns_active" INTEGER NOT NULL DEFAULT 0,
    "campaigns_expired" INTEGER NOT NULL DEFAULT 0,
    "trial_used" BOOLEAN NOT NULL DEFAULT false,
    "last_campaign_created_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "campaign_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "subscription_id" UUID,
    "campaign_type_id" UUID NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "description" TEXT,
    "objective" TEXT,
    "platform" TEXT,
    "creative_type" TEXT,
    "image_url" TEXT,
    "video_url" TEXT,
    "destination_url" TEXT,
    "cta" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "rejection_reason" TEXT,
    "submitted_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "starts_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_creatives" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "type" "CreativeType" NOT NULL,
    "url" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_profiles_user_id_key" ON "agent_profiles"("user_id");

-- CreateIndex
CREATE INDEX "agent_profiles_status_idx" ON "agent_profiles"("status");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");

-- CreateIndex
CREATE INDEX "agent_subscriptions_agent_id_idx" ON "agent_subscriptions"("agent_id");

-- CreateIndex
CREATE INDEX "agent_subscriptions_plan_id_idx" ON "agent_subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "agent_subscriptions_status_idx" ON "agent_subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_usage_agent_id_key" ON "subscription_usage"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_types_code_key" ON "campaign_types"("code");

-- CreateIndex
CREATE INDEX "campaigns_agent_id_idx" ON "campaigns"("agent_id");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "campaigns_subscription_id_idx" ON "campaigns"("subscription_id");

-- CreateIndex
CREATE INDEX "campaigns_expires_at_idx" ON "campaigns"("expires_at");

-- CreateIndex
CREATE INDEX "campaign_creatives_campaign_id_idx" ON "campaign_creatives"("campaign_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_activated_by_fkey" FOREIGN KEY ("activated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "agent_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "agent_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_campaign_type_id_fkey" FOREIGN KEY ("campaign_type_id") REFERENCES "campaign_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_creatives" ADD CONSTRAINT "campaign_creatives_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
