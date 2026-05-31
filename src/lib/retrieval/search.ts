// src/lib/retrieval/search.ts
// Semantic search via pgvector HNSW
// Ticker feed retrieval with filtering and sorting

import { db } from '@/lib/db';

// Semantic search via pgvector
export async function semanticSearch(
  queryText: string,
  options?: {
    limit?: number;
    tickerFilter?: string[];
    dateRange?: { from: Date; to: Date };
  }
) {
  const limit = options?.limit ?? 10;

  // For Phase 1: return recent chunks (placeholder for vector search)
  // TODO: Implement pgvector similarity search with raw SQL
  const chunks = await db.transcriptChunk.findMany({
    take: limit,
    include: {
      episode: {
        include: {
          source: true,
        },
      },
      speaker: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return chunks;
}

// Get ticker feed with sorting and filtering
export async function getTickerFeed(
  ticker: string,
  options?: {
    sort?: 'recency' | 'novelty' | 'conviction';
    limit?: number;
    offset?: number;
    speakerId?: string;
    dateRange?: { from: Date; to: Date };
  }
) {
  const sort = options?.sort ?? 'recency';
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;

  // Find entity by ticker/name
  const entity = await db.entity.findFirst({
    where: {
      OR: [
        { ticker: ticker.toUpperCase() },
        { normalizedName: ticker.toLowerCase() },
      ],
    },
  });

  if (!entity) {
    return { chunks: [], total: 0 };
  }

  // Build query filters
  const where: any = {
    entities: {
      some: {
        entityId: entity.id,
      },
    },
  };

  // Optional speaker filter
  if (options?.speakerId) {
    where.speakerId = options.speakerId;
  }

  // Optional date range
  if (options?.dateRange?.from || options?.dateRange?.to) {
    where.episode = {
      publishedAt: {},
    };
    if (options.dateRange.from) {
      where.episode.publishedAt.gte = options.dateRange.from;
    }
    if (options.dateRange.to) {
      where.episode.publishedAt.lte = options.dateRange.to;
    }
  }

  // Get total count
  const total = await db.transcriptChunk.count({ where });

  // Determine sort order
  let orderBy: any = { createdAt: 'desc' };
  if (sort === 'novelty') {
    orderBy = { noveltyScore: 'desc' };
  } else if (sort === 'conviction') {
    orderBy = { convictionScore: 'desc' };
  }

  // Fetch chunks
  const chunks = await db.transcriptChunk.findMany({
    where,
    include: {
      episode: {
        include: {
          source: true,
        },
      },
      speaker: true,
    },
    orderBy,
    take: limit,
    skip: offset,
  });

  return { chunks, total };
}

// Check if ≥20% of feed has speaker attribution (for UI rendering)
export async function shouldShowSpeakerFilter(ticker: string): Promise<boolean> {
  const entity = await db.entity.findFirst({
    where: {
      OR: [
        { ticker: ticker.toUpperCase() },
        { normalizedName: ticker.toLowerCase() },
      ],
    },
  });

  if (!entity) {
    return false;
  }

  const total = await db.transcriptChunk.count({
    where: {
      entities: {
        some: {
          entityId: entity.id,
        },
      },
    },
  });

  if (total === 0) {
    return false;
  }

  const withSpeaker = await db.transcriptChunk.count({
    where: {
      entities: {
        some: {
          entityId: entity.id,
        },
      },
      speakerId: {
        not: null,
      },
    },
  });

  return withSpeaker / total >= 0.2;
}

// Get all speakers for a ticker (for filtering UI)
export async function getTickerSpeakers(ticker: string) {
  const entity = await db.entity.findFirst({
    where: {
      OR: [
        { ticker: ticker.toUpperCase() },
        { normalizedName: ticker.toLowerCase() },
      ],
    },
  });

  if (!entity) {
    return [];
  }

  const speakers = await db.speaker.findMany({
    where: {
      chunks: {
        some: {
          entities: {
            some: {
              entityId: entity.id,
            },
          },
        },
      },
    },
    select: {
      id: true,
      name: true,
    },
  });

  return speakers;
}
