-- UserInterest: investor monitoring terms
CREATE TABLE "UserInterest" (
  "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"    TEXT NOT NULL DEFAULT 'default',
  "term"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserInterest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UserInterest_userId_idx" ON "UserInterest"("userId");

-- InterestMatch: pre-computed top hits per interest × episode
CREATE TABLE "InterestMatch" (
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "interestId" TEXT NOT NULL,
  "episodeId"  TEXT NOT NULL,
  "chunkId"    TEXT NOT NULL,
  "score"      DOUBLE PRECISION NOT NULL,
  "highlight"  TEXT NOT NULL,
  "keyPhrase"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InterestMatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InterestMatch_interestId_chunkId_key" ON "InterestMatch"("interestId", "chunkId");
CREATE INDEX "InterestMatch_interestId_idx" ON "InterestMatch"("interestId");
CREATE INDEX "InterestMatch_episodeId_idx"  ON "InterestMatch"("episodeId");
CREATE INDEX "InterestMatch_score_idx"      ON "InterestMatch"("score");
CREATE INDEX "InterestMatch_createdAt_idx"  ON "InterestMatch"("createdAt");

ALTER TABLE "InterestMatch"
  ADD CONSTRAINT "InterestMatch_interestId_fkey"
    FOREIGN KEY ("interestId") REFERENCES "UserInterest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "InterestMatch_episodeId_fkey"
    FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "InterestMatch_chunkId_fkey"
    FOREIGN KEY ("chunkId") REFERENCES "TranscriptChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text search index on TranscriptChunk.text
-- tsvector column populated from chunk text; updated via trigger
ALTER TABLE "TranscriptChunk" ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', COALESCE(text, ''))) STORED;

CREATE INDEX "TranscriptChunk_searchVector_idx"
  ON "TranscriptChunk" USING GIN ("searchVector");
