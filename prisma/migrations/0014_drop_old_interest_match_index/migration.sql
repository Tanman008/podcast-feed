-- Migration 0005 created (interestId, chunkId) as a UNIQUE INDEX (not a named constraint).
-- Migration 0012 tried DROP CONSTRAINT which silently no-oped.
-- This drops the index directly so upserts keyed on (interestId, claimId) can proceed.
DROP INDEX IF EXISTS "InterestMatch_interestId_chunkId_key";
