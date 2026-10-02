-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verification_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "email_verification_token_hash" TEXT;

