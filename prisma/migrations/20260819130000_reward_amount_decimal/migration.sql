-- Convert all money columns from integer to DECIMAL(12,2) so reward amounts
-- can carry paise precision (e.g. 25.50) as required by the campaign-based
-- INR reward update. Postgres casts int -> numeric losslessly (35 -> 35.00),
-- so every existing wallet balance and task reward value is preserved.
--
-- The two RENAME COLUMN statements below were moved here from
-- 20260819115420_rename_coins_to_rupees/migration.sql: "tasks" and
-- "user_task_completions" are created by the immediately-preceding
-- migration (20260819123025_task_completion_reward_engine), so the rename
-- can only happen after that, not in 115420 where it originally lived - see
-- the note in that file.
ALTER TABLE "tasks" RENAME COLUMN "reward_coins" TO "reward_amount";
ALTER TABLE "user_task_completions" RENAME COLUMN "reward_coins" TO "reward_amount";

ALTER TABLE "tasks" ALTER COLUMN "reward_amount" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "user_task_completions" ALTER COLUMN "reward_amount" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "user_wallets" ALTER COLUMN "balance" SET DEFAULT 0,
ALTER COLUMN "balance" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "wallet_transactions" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);
