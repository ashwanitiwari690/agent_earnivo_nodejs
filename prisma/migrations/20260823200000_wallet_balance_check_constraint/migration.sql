-- Defense-in-depth (spec Phase 11 §3: "Prevent negative balance"). Every
-- application-level path already validates available balance before
-- debiting (withdrawals.service.ts), but a DB-level CHECK constraint
-- guarantees the invariant even against a future code path that forgets to,
-- a raw query, or manual intervention - the kind of belt-and-suspenders
-- guard a financial ledger table should have regardless of how careful the
-- application code is.
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_balance_non_negative" CHECK ("balance" >= 0);
