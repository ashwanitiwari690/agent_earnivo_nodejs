-- CreateEnum
CREATE TYPE "GameConversionStatus" AS ENUM ('COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "coins_per_conversion" INTEGER NOT NULL DEFAULT 1000,
    "rupees_per_conversion" INTEGER NOT NULL DEFAULT 10,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_coin_conversions" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "game_name" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "mobile_number" TEXT NOT NULL,
    "coins_submitted" INTEGER NOT NULL,
    "coins_converted" INTEGER NOT NULL,
    "coins_per_conversion" INTEGER NOT NULL,
    "rupees_per_conversion" INTEGER NOT NULL,
    "rupee_amount" DECIMAL(12,2) NOT NULL,
    "transaction_reference" TEXT NOT NULL,
    "status" "GameConversionStatus" NOT NULL DEFAULT 'COMPLETED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_coin_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "games_code_key" ON "games"("code");

-- CreateIndex
CREATE INDEX "game_coin_conversions_user_id_created_at_idx" ON "game_coin_conversions"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "game_coin_conversions_game_id_transaction_reference_key" ON "game_coin_conversions"("game_id", "transaction_reference");

-- AddForeignKey
ALTER TABLE "game_coin_conversions" ADD CONSTRAINT "game_coin_conversions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_coin_conversions" ADD CONSTRAINT "game_coin_conversions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

