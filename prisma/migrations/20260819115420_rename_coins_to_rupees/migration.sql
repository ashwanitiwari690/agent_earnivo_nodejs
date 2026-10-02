-- Rename the coin-based reward/balance columns to rupee-based ones.
-- Uses RENAME COLUMN (not drop+add) so every existing balance and reward
-- value is preserved exactly - only the unit's name and interpretation
-- changes, from "coins" to whole Indian Rupees (INR).
--
-- The "tasks"/"user_task_completions" renames that originally lived here
-- were moved to 20260819130000_reward_amount_decimal/migration.sql: those
-- tables aren't created until the next migration
-- (20260819123025_task_completion_reward_engine), so a from-scratch replay
-- of this migration always failed with "relation tasks does not exist" -
-- this file only ever "worked" because every dev database that ran it had
-- already had those tables created out-of-band beforehand. Fixed here so
-- `prisma migrate reset` can succeed against a genuinely empty database.

ALTER TABLE "user_wallets" RENAME COLUMN "coin_balance" TO "balance";
