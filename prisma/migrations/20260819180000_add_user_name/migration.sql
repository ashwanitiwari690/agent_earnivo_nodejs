-- Adds an optional display name for users, so the mobile app can greet a
-- user by name instead of only by phone number. Nullable since existing
-- OTP-only accounts never collected one.

ALTER TABLE "users" ADD COLUMN "name" TEXT;
