-- Add podcast to SourceType enum
ALTER TYPE "SourceType" ADD VALUE IF NOT EXISTS 'podcast';

-- Add RSS feed URL to Source for direct polling (bypasses Podcast Index crawl lag)
ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "feedUrl" TEXT;
