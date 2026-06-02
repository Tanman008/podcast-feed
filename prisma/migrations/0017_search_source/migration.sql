-- Add search subscription source type
ALTER TYPE "SourceType" ADD VALUE IF NOT EXISTS 'search';

-- Add searchQuery field to Source for keyword-based subscriptions
ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "searchQuery" TEXT;
