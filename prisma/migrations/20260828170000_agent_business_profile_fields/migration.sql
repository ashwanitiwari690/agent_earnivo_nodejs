-- AlterTable
ALTER TABLE "agent_profiles" ADD COLUMN     "address" TEXT,
ADD COLUMN     "business_type" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "invoice_preference" TEXT NOT NULL DEFAULT 'email',
ADD COLUMN     "state" TEXT,
ADD COLUMN     "tax_id" TEXT,
ADD COLUMN     "website" TEXT;

