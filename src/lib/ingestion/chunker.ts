// lib/ingestion/chunker.ts
// Sliding window chunking with sentence boundary detection
// Target: 400 tokens, Max: 600 tokens, Overlap: 80 tokens

import { countTokens } from '@/lib/utils/tokenizer';
import { OPTIMIZATION_CONFIG } from '@/lib/config/optimization';

export interface RawChunk {
  text: string;
  cleanedText: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  tokenCount: number;
  chunkIndex: number;
}

interface TranscriptSegment {
  text: string;
  offset: number;
  duration: number;
}

export async function chunkTranscript(
  transcript: TranscriptSegment[],
  options?: {
    skipPattern?: RegExp;
    targetTokens?: number;
    maxTokens?: number;
    overlapTokens?: number;
    minTokens?: number;
  }
): Promise<RawChunk[]> {
  const targetTokens = options?.targetTokens ?? OPTIMIZATION_CONFIG.CHUNKING.TARGET_TOKENS;
  const maxTokens = options?.maxTokens ?? OPTIMIZATION_CONFIG.CHUNKING.MAX_TOKENS;
  const overlapTokens = options?.overlapTokens ?? OPTIMIZATION_CONFIG.CHUNKING.OVERLAP_TOKENS;
  const minTokens = options?.minTokens ?? OPTIMIZATION_CONFIG.CHUNKING.MIN_TOKENS;
  const skipPattern = options?.skipPattern ?? OPTIMIZATION_CONFIG.CHUNK_SKIP_PATTERN;

  if (transcript.length === 0) {
    return [];
  }

  const chunks: RawChunk[] = [];
  let currentSegmentIndex = 0;
  let chunkIndex = 0;

  while (currentSegmentIndex < transcript.length) {
    const chunkSegments: TranscriptSegment[] = [];
    let currentTokenCount = 0;
    let overlapCarryover = '';

    // Build chunk until we reach target tokens
    while (currentSegmentIndex < transcript.length && currentTokenCount < targetTokens) {
      const segment = transcript[currentSegmentIndex];
      const text = overlapCarryover ? overlapCarryover + ' ' + segment.text : segment.text;

      // Check skip pattern (Phase 2 optimization hook)
      if (skipPattern && skipPattern.test(segment.text)) {
        currentSegmentIndex++;
        continue;
      }

      const newTokenCount = countTokens(text);

      // If adding this segment exceeds max tokens, try to split at sentence boundary
      if (newTokenCount > maxTokens) {
        // Force split at current position if we have content
        if (chunkSegments.length > 0) {
          break;
        }
        // If single segment is larger than max, include it anyway (can't split further)
        chunkSegments.push(segment);
        currentTokenCount = newTokenCount;
        currentSegmentIndex++;
        break;
      }

      chunkSegments.push(segment);
      currentTokenCount = newTokenCount;
      overlapCarryover = '';
      currentSegmentIndex++;

      // If we've reached target tokens, look for sentence boundary to split
      if (currentTokenCount >= targetTokens) {
        // Try to find sentence boundary in the last few segments
        let bestSplitIndex = chunkSegments.length;

        for (let i = chunkSegments.length - 1; i >= Math.max(0, chunkSegments.length - 3); i--) {
          const segmentText = chunkSegments[i].text;
          if (/[.!?]$/.test(segmentText.trim())) {
            bestSplitIndex = i + 1;
            break;
          }
        }

        // Extract overlap for next chunk
        if (bestSplitIndex < chunkSegments.length) {
          const overlapSegments = chunkSegments.slice(bestSplitIndex);
          let overlapText = overlapSegments.map(s => s.text).join(' ');
          let overlapTokenCount = countTokens(overlapText);

          // Trim overlap if it exceeds overlapTokens
          while (overlapTokenCount > overlapTokens && overlapSegments.length > 0) {
            overlapSegments.shift();
            overlapText = overlapSegments.map(s => s.text).join(' ');
            overlapTokenCount = countTokens(overlapText);
          }

          overlapCarryover = overlapText;
          // Backtrack currentSegmentIndex to reprocess overlap segments
          currentSegmentIndex -= overlapSegments.length;
        }

        // Keep only the chunks up to bestSplitIndex
        chunkSegments.splice(bestSplitIndex);
        break;
      }
    }

    if (chunkSegments.length === 0) {
      break;
    }

    // Build the chunk text
    const chunkText = chunkSegments.map(s => s.text).join(' ');
    const cleanedText = chunkText
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    const tokenCount = countTokens(chunkText);

    // Discard chunks below minimum token threshold
    if (tokenCount < minTokens) {
      continue;
    }

    const startTime = chunkSegments[0].offset / 1000;
    const endTime = (chunkSegments[chunkSegments.length - 1].offset + chunkSegments[chunkSegments.length - 1].duration) / 1000;

    chunks.push({
      text: chunkText,
      cleanedText,
      startTimeSeconds: startTime,
      endTimeSeconds: endTime,
      tokenCount,
      chunkIndex,
    });

    chunkIndex++;
  }

  return chunks;
}
