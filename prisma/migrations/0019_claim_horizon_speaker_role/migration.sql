-- Temporal orientation + speaker role for investor-relevance scoring.
-- horizon: retrospective | forward | timeless
-- speakerRole: insider | investor | analyst | host | other
ALTER TABLE "Claim" ADD COLUMN IF NOT EXISTS "horizon" TEXT;
ALTER TABLE "Claim" ADD COLUMN IF NOT EXISTS "speakerRole" TEXT;
