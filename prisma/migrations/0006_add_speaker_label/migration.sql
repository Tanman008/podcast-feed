-- Add speakerLabel column to TranscriptChunk
-- Stores raw Deepgram diarization label ("0", "1", …) per chunk.
-- Nullable: episodes ingested via the old YouTube-caption pipeline have no speaker data.
ALTER TABLE "TranscriptChunk" ADD COLUMN "speakerLabel" TEXT;
