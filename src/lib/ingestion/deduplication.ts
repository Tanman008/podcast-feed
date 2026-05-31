// lib/ingestion/deduplication.ts
// Checks for duplicate episodes before ingestion
// Phase 1: Fast videoId uniqueness check
// Phase 2: Transcript hash deduplication (catches re-uploads)

import crypto from 'crypto';
import { db } from '@/lib/db';
import { OPTIMIZATION_CONFIG } from '@/lib/config/optimization';

// Phase 1: Check if episode with same videoId already exists
export async function checkEpisodeExists(
  videoId: string,
  sourceId: string
): Promise<boolean> {
  const episode = await db.episode.findUnique({
    where: {
      sourceId_externalId: {
        sourceId,
        externalId: videoId,
      },
    },
  });

  return !!episode;
}

// Phase 2 hook: Compute transcript hash for deduplication
// Catches re-uploaded episodes with same content
export function computeTranscriptHash(transcript: string): string {
  return crypto
    .createHash('sha256')
    .update(transcript.toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');
}

// Phase 2: Check for duplicate by transcript hash
export async function checkDuplicateByHash(
  transcriptHash: string
): Promise<boolean> {
  if (!OPTIMIZATION_CONFIG.ENABLE_DEDUPLICATION) {
    return false;
  }

  // TODO: Phase 2 - Add rawTranscriptHash field to Episode schema
  // Then query: const dup = await db.episode.findFirst({ where: { rawTranscriptHash: transcriptHash } });
  // For now, this is a no-op hook

  return false;
}

// Main deduplication check (combines Phase 1 + Phase 2 logic)
export async function checkIsDuplicate(
  videoId: string,
  sourceId: string,
  transcript?: string
): Promise<{ isDuplicate: boolean; reason?: string }> {
  // Phase 1: Fast videoId check (always enabled)
  const existsByVideoId = await checkEpisodeExists(videoId, sourceId);
  if (existsByVideoId) {
    return { isDuplicate: true, reason: 'videoId already exists' };
  }

  // Phase 2: Hash-based deduplication (if enabled)
  if (OPTIMIZATION_CONFIG.ENABLE_DEDUPLICATION && transcript) {
    const hash = computeTranscriptHash(transcript);
    const isDuplicateHash = await checkDuplicateByHash(hash);
    if (isDuplicateHash) {
      return { isDuplicate: true, reason: 'transcript content already exists (hash match)' };
    }
  }

  return { isDuplicate: false };
}
