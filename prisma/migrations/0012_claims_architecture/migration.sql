-- Clean slate: wipe all existing match data (reingestion required)
TRUNCATE "InterestMatch";

-- Create Claim table
CREATE TABLE IF NOT EXISTS "Claim" (
  "id"                 TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "chunkId"            TEXT NOT NULL,
  "highlight"          TEXT NOT NULL,
  "startSentenceIndex" INTEGER NOT NULL DEFAULT 0,
  "endSentenceIndex"   INTEGER NOT NULL DEFAULT 0,
  "primarySubject"     TEXT,
  "mentionedEntities"  TEXT[] NOT NULL DEFAULT '{}',
  "claimType"          TEXT NOT NULL,
  "specificity"        DOUBLE PRECISION NOT NULL,
  "completeness"       DOUBLE PRECISION NOT NULL,
  "gloss"              TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Claim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Claim_chunkId_fkey" FOREIGN KEY ("chunkId")
    REFERENCES "TranscriptChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Claim_chunkId_idx"     ON "Claim"("chunkId");
CREATE INDEX IF NOT EXISTS "Claim_claimType_idx"   ON "Claim"("claimType");
CREATE INDEX IF NOT EXISTS "Claim_completeness_idx" ON "Claim"("completeness");

-- Drop old InterestMatch unique constraint
ALTER TABLE "InterestMatch" DROP CONSTRAINT IF EXISTS "InterestMatch_interestId_chunkId_key";

-- Drop old columns (table is empty so no data loss)
ALTER TABLE "InterestMatch" DROP COLUMN IF EXISTS "highlight";
ALTER TABLE "InterestMatch" DROP COLUMN IF EXISTS "keyPhrase";
ALTER TABLE "InterestMatch" DROP COLUMN IF EXISTS "gloss";

-- Add new columns
ALTER TABLE "InterestMatch" ADD COLUMN IF NOT EXISTS "claimId"      TEXT;
ALTER TABLE "InterestMatch" ADD COLUMN IF NOT EXISTS "entityWeight" DOUBLE PRECISION NOT NULL DEFAULT 1.0;

-- Add FK for claimId
ALTER TABLE "InterestMatch" DROP CONSTRAINT IF EXISTS "InterestMatch_claimId_fkey";
ALTER TABLE "InterestMatch" ADD CONSTRAINT "InterestMatch_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- New unique constraint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'InterestMatch'
    AND indexname = 'InterestMatch_interestId_claimId_key'
  ) THEN
    CREATE UNIQUE INDEX "InterestMatch_interestId_claimId_key"
      ON "InterestMatch"("interestId", "claimId");
  END IF;
END $$;
