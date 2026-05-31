// lib/scoring/novelty.ts
// Pass 2 novelty scoring - compares chunk embeddings against prior same-entity chunks
// Runs after all chunks are persisted and embedded
// Query 50 most recent chunks per entity, compute cosine distance

import { Entity, ChunkEntity } from '@prisma/client';
import { db } from '@/lib/db';
import { cosineSimilarity } from '@/lib/utils/cosine';
import { OPTIMIZATION_CONFIG } from '@/lib/config/optimization';

// Raw row shape returned by the $queryRaw embedding fetch
interface ChunkWithEmbedding {
  id: string;
  embedding: number[];
}

// Chunk shape used for novelty input — embedding fetched separately via raw SQL
interface ChunkForNovelty {
  id: string;
  episodeId: string;
  embedding: number[] | null;
  entities: (ChunkEntity & { entity: Entity })[];
}

export async function scoreNovelty(
  chunk: ChunkForNovelty,
  options?: {
    batchMode?: boolean; // Phase 2 hook: defer to batch processor
  }
): Promise<number> {
  // Phase 2 hook: deferred batch novelty scoring
  if (options?.batchMode) {
    return 0.5; // placeholder
  }

  if (!chunk.embedding || chunk.entities.length === 0) {
    return 0.5; // neutral if no embedding or entities
  }

  const noveltyScores: number[] = [];

  for (const chunkEntity of chunk.entities) {
    const entityNovelty = await scoreNoveltyForEntity(chunk, chunkEntity.entityId);
    noveltyScores.push(entityNovelty);
  }

  if (noveltyScores.length === 0) {
    return 0.5;
  }

  // MAX across entities: chunk is novel if ANY entity finds it novel
  const maxNovelty = Math.max(...noveltyScores);
  return Math.max(0, Math.min(1, maxNovelty));
}

async function scoreNoveltyForEntity(
  chunk: ChunkForNovelty,
  entityId: string
): Promise<number> {
  const priorLimit = OPTIMIZATION_CONFIG.NOVELTY.PRIOR_CHUNK_LIMIT;
  const minPriorChunks = OPTIMIZATION_CONFIG.NOVELTY.MIN_PRIOR_CHUNKS;
  const defaultScore = OPTIMIZATION_CONFIG.NOVELTY.DEFAULT_SCORE_NO_PRIOR;

  // Raw SQL: fetch 50 most recent chunks for this entity (excluding current episode)
  // embedding is Unsupported("vector(1536)") so must use $queryRaw
  const priorChunks = await db.$queryRaw<ChunkWithEmbedding[]>`
    SELECT tc.id, tc.embedding::text AS embedding
    FROM "TranscriptChunk" tc
    INNER JOIN "ChunkEntity" ce ON ce."chunkId" = tc.id
    WHERE ce."entityId" = ${entityId}
      AND tc."episodeId" != ${chunk.episodeId}
      AND tc.embedding IS NOT NULL
    ORDER BY tc."createdAt" DESC
    LIMIT ${priorLimit}
  `;

  if (priorChunks.length < minPriorChunks) {
    return defaultScore;
  }

  // Postgres returns vector as a string like "[0.1,0.2,...]" — parse it
  const chunkEmbedding = chunk.embedding!;
  const similarities = priorChunks.map(prior => {
    const priorEmbedding: number[] = JSON.parse(
      (prior.embedding as unknown as string).replace(/^\[/, '[').trim()
    );
    return cosineSimilarity(chunkEmbedding, priorEmbedding);
  });

  const maxSimilarity = Math.max(...similarities);
  return Math.max(0, Math.min(1, 1 - maxSimilarity));
}

// Bulk score novelty for all chunks in an episode after Pass 1
// Fetches embeddings via raw SQL since Prisma excludes Unsupported fields from results
export async function scoreNoveltyBatch(episodeId: string): Promise<number> {
  // Fetch chunk metadata (no embedding — not available via Prisma client)
  const chunks = await db.transcriptChunk.findMany({
    where: { episodeId },
    include: {
      entities: {
        include: { entity: true },
      },
    },
  });

  if (chunks.length === 0) return 0;

  // Fetch embeddings for all chunks in this episode via raw SQL
  const embeddingRows = await db.$queryRaw<{ id: string; embedding: string }[]>`
    SELECT id, embedding::text AS embedding
    FROM "TranscriptChunk"
    WHERE "episodeId" = ${episodeId}
      AND embedding IS NOT NULL
  `;

  const embeddingMap = new Map<string, number[]>(
    embeddingRows.map(row => [
      row.id,
      JSON.parse(row.embedding.trim()),
    ])
  );

  let updatedCount = 0;

  for (const chunk of chunks) {
    const chunkForNovelty: ChunkForNovelty = {
      id: chunk.id,
      episodeId: chunk.episodeId,
      embedding: embeddingMap.get(chunk.id) ?? null,
      entities: chunk.entities,
    };

    const noveltyScore = await scoreNovelty(chunkForNovelty, { batchMode: false });

    await db.transcriptChunk.update({
      where: { id: chunk.id },
      data: { noveltyScore },
    });

    updatedCount++;
  }

  return updatedCount;
}

export function estimateNoveltyComputeCost(_chunkCount: number): number {
  return 0;
}
