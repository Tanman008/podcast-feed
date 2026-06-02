-- Add gloss column to InterestMatch for caching LLM-generated investor framing
ALTER TABLE "InterestMatch" ADD COLUMN IF NOT EXISTS "gloss" TEXT;
