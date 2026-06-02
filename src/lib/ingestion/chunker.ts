// lib/ingestion/chunker.ts
// Word-based, speaker-turn-aware chunker.
// Primary unit: speaker turn. A speaker change is always a chunk boundary.
// Long turns (>300 words) are split at sentence boundaries near 250 words
// with a 30-word sentence-level overlap into the next chunk.

import { countTokens } from '@/lib/utils/tokenizer';

export interface RawChunk {
  text: string;
  cleanedText: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  tokenCount: number;
  chunkIndex: number;
  speakerLabel?: string;
}

export interface TranscriptSegment {
  text: string;
  offset: number;    // milliseconds
  duration: number;  // milliseconds
  speakerLabel?: string;
}

const TARGET_WORDS  = 250;
const MAX_WORDS     = 300;
const OVERLAP_WORDS = 30;
const MIN_WORDS     = 20;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

interface PositionedSentence {
  text: string;
  wordStart: number; // word index in the full turn text
  wordEnd: number;   // inclusive
}

function splitSentencesPositioned(text: string): PositionedSentence[] {
  const results: PositionedSentence[] = [];
  const regex = /[^.!?]+[.!?]*/g;
  let wordPos = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const s = match[0].trim();
    if (!s) continue;
    const wc = countWords(s);
    if (wc === 0) continue;
    results.push({ text: s, wordStart: wordPos, wordEnd: wordPos + wc - 1 });
    wordPos += wc;
  }
  if (results.length === 0) {
    const wc = countWords(text.trim());
    results.push({ text: text.trim(), wordStart: 0, wordEnd: Math.max(0, wc - 1) });
  }
  return results;
}

// wordMap[i] = index of segment that word i belongs to
function buildWordMap(segs: TranscriptSegment[]): number[] {
  const wordMap: number[] = [];
  for (let i = 0; i < segs.length; i++) {
    const wc = countWords(segs[i].text);
    for (let j = 0; j < wc; j++) wordMap.push(i);
  }
  return wordMap;
}

function groupIntoSpeakerTurns(
  segments: TranscriptSegment[]
): Array<{ speakerLabel: string | undefined; segments: TranscriptSegment[] }> {
  const turns: Array<{ speakerLabel: string | undefined; segments: TranscriptSegment[] }> = [];
  for (const seg of segments) {
    const last = turns[turns.length - 1];
    if (!last || last.speakerLabel !== seg.speakerLabel) {
      turns.push({ speakerLabel: seg.speakerLabel, segments: [seg] });
    } else {
      last.segments.push(seg);
    }
  }
  return turns;
}

function chunkTurn(
  segs: TranscriptSegment[],
  speakerLabel: string | undefined,
  baseIndex: number
): RawChunk[] {
  const fullText = segs.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
  const totalWords = countWords(fullText);

  if (totalWords < MIN_WORDS) return [];

  if (totalWords <= MAX_WORDS) {
    const last = segs[segs.length - 1];
    return [{
      text: fullText,
      cleanedText: fullText.toLowerCase(),
      startTimeSeconds: segs[0].offset / 1000,
      endTimeSeconds: (last.offset + last.duration) / 1000,
      tokenCount: countTokens(fullText),
      chunkIndex: baseIndex,
      speakerLabel,
    }];
  }

  // Long turn: split at sentence boundaries near TARGET_WORDS with OVERLAP_WORDS overlap
  const sentences = splitSentencesPositioned(fullText);
  const wordMap = buildWordMap(segs);
  const result: RawChunk[] = [];
  let chunkCount = 0;
  let nextSent = 0;
  let overlapFrom = -1; // sentence index where overlap starts (-1 = no overlap yet)

  while (nextSent < sentences.length) {
    const chunkStart = overlapFrom >= 0 ? overlapFrom : nextSent;
    let currEnd = nextSent - 1;
    let words = sentences
      .slice(chunkStart, nextSent)
      .reduce((s, sent) => s + countWords(sent.text), 0);

    // Accumulate new sentences until target reached or max would be exceeded
    while (nextSent < sentences.length) {
      const sw = countWords(sentences[nextSent].text);
      // Only gate on max if we already have some new content
      if (words + sw > MAX_WORDS && currEnd >= chunkStart) break;
      words += sw;
      currEnd = nextSent;
      nextSent++;
      if (words >= TARGET_WORDS) break;
    }

    if (currEnd < chunkStart) break;

    const chunkSents = sentences.slice(chunkStart, currEnd + 1);
    const chunkText = chunkSents.map(s => s.text).join(' ');
    if (countWords(chunkText) >= MIN_WORDS) {
      const sw0 = chunkSents[0].wordStart;
      const swN = chunkSents[chunkSents.length - 1].wordEnd;
      const startSeg = segs[wordMap[Math.min(sw0, wordMap.length - 1)] ?? 0];
      const endSeg   = segs[wordMap[Math.min(swN, wordMap.length - 1)] ?? segs.length - 1];

      result.push({
        text: chunkText,
        cleanedText: chunkText.toLowerCase(),
        startTimeSeconds: startSeg.offset / 1000,
        endTimeSeconds: (endSeg.offset + endSeg.duration) / 1000,
        tokenCount: countTokens(chunkText),
        chunkIndex: baseIndex + chunkCount++,
        speakerLabel,
      });
    }

    // Overlap: walk back from currEnd, accumulate ~OVERLAP_WORDS worth of complete sentences
    let ow = 0;
    overlapFrom = currEnd + 1;
    for (let i = currEnd; i >= chunkStart; i--) {
      const sw = countWords(sentences[i].text);
      if (ow + sw > OVERLAP_WORDS && ow > 0) break;
      ow += sw;
      overlapFrom = i;
    }
    if (overlapFrom > currEnd) overlapFrom = -1;
  }

  return result;
}

export async function chunkTranscript(
  segments: TranscriptSegment[]
): Promise<RawChunk[]> {
  if (segments.length === 0) return [];
  const turns = groupIntoSpeakerTurns(segments);
  const chunks: RawChunk[] = [];
  for (const turn of turns) {
    chunks.push(...chunkTurn(turn.segments, turn.speakerLabel, chunks.length));
  }
  return chunks;
}
