/**
 * scripts/rechunk.ts
 *
 * Re-chunks all completed episodes using the new 250-word speaker-turn-aware
 * chunker. Converts existing chunks into pseudo-segments (preserving speaker
 * labels and timestamps), re-runs embedding + entity analysis + claim
 * extraction, then re-scores novelty.
 *
 * Deletes all existing chunks, claims, entities, and interest matches for each
 * episode before writing the new ones. Run reindex on each interest afterward.
 *
 * Usage:
 *   npm run rechunk                        # all completed episodes
 *   npm run rechunk -- --episode <id>      # single episode
 *
 * The script reads .env.local automatically.
 */

import '../src/lib/worker/env';
import { db } from '../src/lib/db';
import { chunkTranscript, TranscriptSegment } from '../src/lib/ingestion/chunker';
import { embedChunks } from '../src/lib/ingestion/embedder';
import { analyzeChunksBatch } from '../src/lib/ingestion/entityExtractor';
import { scoreNoveltyBatch } from '../src/lib/scoring/novelty';
import { preExtractEpisodeClaims } from '../src/lib/matching/engine';

async function rechunkEpisode(episodeId: string, title: string): Promise<void> {
  const existing = await db.transcriptChunk.findMany({
    where: { episodeId },
    orderBy: { chunkIndex: 'asc' },
    select: {
      text: true,
      startTimeSeconds: true,
      endTimeSeconds: true,
      speakerLabel: true,
    },
  });

  if (existing.length === 0) {
    console.log(`  [skip] no chunks`);
    return;
  }

  // Convert stored chunks to pseudo-segments so the chunker can re-merge them
  const pseudoSegments: TranscriptSegment[] = existing.map(c => ({
    text: c.text,
    offset: c.startTimeSeconds * 1000,
    duration: Math.max(1, (c.endTimeSeconds - c.startTimeSeconds) * 1000),
    speakerLabel: c.speakerLabel ?? undefined,
  }));

  const newChunks = await chunkTranscript(pseudoSegments);
  console.log(`  ${existing.length} chunks → ${newChunks.length} chunks`);

  if (newChunks.length === 0) {
    console.log(`  [skip] rechunker produced 0 chunks`);
    return;
  }

  // Delete old data — cascades to Claim, ChunkEntity, InterestMatch
  await db.transcriptChunk.deleteMany({ where: { episodeId } });

  // Embed new chunks (one batched OpenAI call)
  const embeddings = await embedChunks(newChunks);

  // Entity extraction + scoring (concurrency 8)
  const analyses = await analyzeChunksBatch(newChunks, { concurrency: 8 });

  // Persist new chunks
  for (let i = 0; i < newChunks.length; i++) {
    const chunk = newChunks[i];
    const embedding = embeddings[i];
    const analysis = analyses[i];

    const dbChunk = await db.transcriptChunk.create({
      data: {
        episodeId,
        speakerId: null,
        chunkIndex: i,
        text: chunk.text,
        cleanedText: chunk.cleanedText,
        keyQuote: analysis.keyQuote ?? null,
        keyPhrase: analysis.keyPhrase ?? null,
        startTimeSeconds: chunk.startTimeSeconds,
        endTimeSeconds: chunk.endTimeSeconds,
        tokenCount: chunk.tokenCount,
        importanceScore: analysis.claimSpecificityScore,
        convictionScore: analysis.forwardLookingScore,
        speakerLabel: chunk.speakerLabel ?? null,
        speakerName: null,
        relevanceScore: null,
      },
    });

    await db.$executeRaw`
      UPDATE "TranscriptChunk"
      SET embedding = ${JSON.stringify(embedding)}::vector
      WHERE id = ${dbChunk.id}
    `;

    for (const e of analysis.entities) {
      const entity = await db.entity.upsert({
        where: {
          normalizedName_entityType: {
            normalizedName: e.normalizedName,
            entityType: e.entityType,
          },
        },
        update: { ticker: e.ticker || null },
        create: {
          name: e.name,
          normalizedName: e.normalizedName,
          entityType: e.entityType,
          ticker: e.ticker || null,
        },
      });

      await db.chunkEntity.upsert({
        where: { chunkId_entityId: { chunkId: dbChunk.id, entityId: entity.id } },
        update: { confidence: e.confidence, mentionType: e.mentionType },
        create: {
          chunkId: dbChunk.id,
          entityId: entity.id,
          confidence: e.confidence,
          mentionType: e.mentionType,
        },
      });
    }
  }

  await scoreNoveltyBatch(episodeId);
  await preExtractEpisodeClaims(episodeId);
}

async function main() {
  const args = process.argv.slice(2);
  const singleEpisodeIdx = args.indexOf('--episode');
  const singleEpisodeId = singleEpisodeIdx >= 0 ? args[singleEpisodeIdx + 1] : null;

  const episodes = await db.episode.findMany({
    where: {
      transcriptStatus: 'completed',
      ...(singleEpisodeId ? { id: singleEpisodeId } : {}),
    },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  });

  if (episodes.length === 0) {
    console.log('No completed episodes found.');
    process.exit(0);
  }

  console.log(`Rechunking ${episodes.length} episode(s)...\n`);

  for (const ep of episodes) {
    console.log(`[${ep.title}]`);
    try {
      await rechunkEpisode(ep.id, ep.title);
    } catch (err: any) {
      console.error(`  [error] ${err?.message ?? err}`);
    }
  }

  console.log('\nDone. Run Re-scan on each interest to rebuild matches.');
  await db.$disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
