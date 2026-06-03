// src/lib/retrieval/search.ts
// Ticker feed retrieval — vector search + full-text re-ranking within entity-filtered chunks.
// Same pipeline as the interest matching engine; embedding a ticker name costs ~$0 per request.

import { db } from '@/lib/db';
import { openai, openaiCall } from '@/lib/openai/client';

const TICKER_ALIASES: Record<string, string> = {
  'GOOG': 'GOOGL',
  'BRK.A': 'BRK.B',
};

function resolveTickerAlias(ticker: string): string {
  return TICKER_ALIASES[ticker.toUpperCase()] ?? ticker.toUpperCase();
}

async function findEntityIds(ticker: string): Promise<string[]> {
  const entities = await db.entity.findMany({
    where: {
      OR: [
        { ticker: resolveTickerAlias(ticker) },
        { normalizedName: ticker.toLowerCase() },
      ],
    },
    select: { id: true, name: true },
  });
  return entities.map(e => e.id);
}

async function embedQuery(text: string): Promise<number[]> {
  const res = await openaiCall(() => openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    dimensions: 1536,
  }));
  return res.data[0].embedding;
}

// Vector search within entity-linked chunks for a ticker.
// Joins ChunkEntity to ensure results are explicitly about this company.
async function vectorSearchForTicker(
  embedding: number[],
  entityIds: string[],
  limit: number,
  offset: number,
): Promise<{ id: string; similarity: number }[]> {
  if (entityIds.length === 0) return [];
  const vectorStr = JSON.stringify(embedding);

  return db.$queryRaw<{ id: string; similarity: number }[]>`
    SELECT DISTINCT tc.id,
           1 - (tc.embedding <=> ${vectorStr}::vector) AS similarity
    FROM "TranscriptChunk" tc
    INNER JOIN "ChunkEntity" ce ON ce."chunkId" = tc.id
    WHERE tc.embedding IS NOT NULL
      AND ce."entityId" = ANY(${entityIds}::text[])
    ORDER BY tc.embedding <=> ${vectorStr}::vector
    LIMIT ${limit + offset}
  `;
}

// Full-text boost within a set of chunk IDs
async function fullTextBoost(
  chunkIds: string[],
  tsquery: string,
): Promise<Map<string, number>> {
  if (chunkIds.length === 0 || !tsquery) return new Map();
  try {
    const rows = await db.$queryRaw<{ id: string; rank: number }[]>`
      SELECT id, ts_rank("searchVector", to_tsquery('english', ${tsquery})) AS rank
      FROM "TranscriptChunk"
      WHERE id = ANY(${chunkIds}::text[])
        AND "searchVector" @@ to_tsquery('english', ${tsquery})
    `;
    return new Map(rows.map(r => [r.id, Number(r.rank)]));
  } catch {
    return new Map();
  }
}

export async function getTickerFeed(
  ticker: string,
  options?: {
    sort?: 'recency' | 'novelty' | 'conviction' | 'relevance';
    limit?: number;
    offset?: number;
    speakerId?: string;
    dateRange?: { from: Date; to: Date };
  }
) {
  const sort = options?.sort ?? 'relevance';
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;

  const entityIds = await findEntityIds(ticker);
  if (entityIds.length === 0) return { chunks: [], total: 0 };

  const total = await db.transcriptChunk.count({
    where: { entities: { some: { entityId: { in: entityIds } } } },
  });

  // For non-relevance sorts: fall back to plain SQL sort (fast, no embedding needed)
  if (sort !== 'relevance') {
    const where: any = { entities: { some: { entityId: { in: entityIds } } } };
    if (options?.speakerId) where.speakerId = options.speakerId;
    if (options?.dateRange) {
      where.episode = { publishedAt: {} };
      if (options.dateRange.from) where.episode.publishedAt.gte = options.dateRange.from;
      if (options.dateRange.to) where.episode.publishedAt.lte = options.dateRange.to;
    }

    const orderBy: any =
      sort === 'novelty' ? { noveltyScore: 'desc' }
      : sort === 'conviction' ? { convictionScore: 'desc' }
      : { createdAt: 'desc' };

    const chunks = await db.transcriptChunk.findMany({
      where,
      include: { episode: { include: { source: true } }, entities: { include: { entity: true } } },
      orderBy,
      take: limit,
      skip: offset,
    });
    return { chunks, total };
  }

  // Relevance sort: embed the ticker name + run vector search + full-text re-rank
  const embedding = await embedQuery(resolveTickerAlias(ticker));
  const vectorResults = await vectorSearchForTicker(embedding, entityIds, limit * 3, 0);

  if (vectorResults.length === 0) return { chunks: [], total };

  const chunkIds = vectorResults.map(r => r.id);
  const safeQuery = ticker.replace(/[^a-zA-Z0-9]/g, ' ').trim();
  const textScores = await fullTextBoost(chunkIds, safeQuery || ticker);

  // Combine: 70% vector, 30% full-text
  const maxText = Math.max(...Array.from(textScores.values()), 0.001);
  const scored = vectorResults.map(r => ({
    id: r.id,
    score: 0.7 * r.similarity + 0.3 * ((textScores.get(r.id) ?? 0) / maxText),
  }));
  scored.sort((a, b) => b.score - a.score);

  const pageIds = scored.slice(offset, offset + limit).map(r => r.id);
  if (pageIds.length === 0) return { chunks: [], total };

  // Fetch full chunk data for the ranked page
  const chunkMap = await db.transcriptChunk.findMany({
    where: { id: { in: pageIds } },
    include: { episode: { include: { source: true } }, entities: { include: { entity: true } } },
  });

  // Preserve vector ranking order
  const byId = new Map(chunkMap.map(c => [c.id, c]));
  const chunks = pageIds.map(id => byId.get(id)).filter(Boolean) as typeof chunkMap;

  return { chunks, total };
}

export async function shouldShowSpeakerFilter(ticker: string): Promise<boolean> {
  const entityIds = await findEntityIds(ticker);
  if (entityIds.length === 0) return false;
  const entityFilter = { some: { entityId: { in: entityIds } } };
  const total = await db.transcriptChunk.count({ where: { entities: entityFilter } });
  if (total === 0) return false;
  const withSpeaker = await db.transcriptChunk.count({
    where: { entities: entityFilter, speakerId: { not: null } },
  });
  return withSpeaker / total >= 0.2;
}

export async function getTickerSpeakers(ticker: string) {
  const entityIds = await findEntityIds(ticker);
  if (entityIds.length === 0) return [];
  return db.speaker.findMany({
    where: { chunks: { some: { entities: { some: { entityId: { in: entityIds } } } } } },
    select: { id: true, name: true },
  });
}
