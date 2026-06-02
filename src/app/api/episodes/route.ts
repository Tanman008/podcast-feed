// GET /api/episodes — list all ingested episodes with chunk + entity counts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  try {
    const episodes = await db.episode.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        source: { select: { name: true, platform: true } },
        _count: { select: { chunks: true } },
      },
    });

    // Fetch top entities per episode via ChunkEntity
    const episodeIds = episodes.map(e => e.id);

    const entityRows = await db.chunkEntity.groupBy({
      by: ['entityId'],
      where: {
        chunk: { episodeId: { in: episodeIds } },
      },
      _count: { entityId: true },
    });

    // For each episode, get its top entities
    const episodeEntityMap = new Map<string, { name: string; ticker: string | null }[]>();

    if (entityRows.length > 0) {
      // Get the actual entities for all entityIds
      const entityDetails = await db.entity.findMany({
        where: { id: { in: entityRows.map(r => r.entityId) } },
        select: { id: true, name: true, ticker: true },
      });
      const entityById = new Map(entityDetails.map(e => [e.id, e]));

      // For each episode, find which entities appear in its chunks
      for (const episode of episodes) {
        const chunkIds = await db.transcriptChunk.findMany({
          where: { episodeId: episode.id },
          select: { id: true },
        });
        const chunkIdSet = new Set(chunkIds.map(c => c.id));

        const epEntityLinks = await db.chunkEntity.findMany({
          where: { chunkId: { in: Array.from(chunkIdSet) } },
          select: { entityId: true },
          distinct: ['entityId'],
          take: 8,
        });

        episodeEntityMap.set(
          episode.id,
          epEntityLinks
            .map(l => entityById.get(l.entityId))
            .filter((e): e is { id: string; name: string; ticker: string | null } => !!e)
            .map(e => ({ name: e.name, ticker: e.ticker }))
        );
      }
    }

    return NextResponse.json({
      episodes: episodes.map(ep => ({
        id: ep.id,
        externalId: ep.externalId,
        title: ep.title,
        transcriptStatus: ep.transcriptStatus,
        chunkCount: ep._count.chunks,
        source: ep.source,
        publishedAt: ep.publishedAt,
        createdAt: ep.createdAt,
        entities: episodeEntityMap.get(ep.id) ?? [],
      })),
    });
  } catch (error: any) {
    console.error('[API] Episodes error:', error);
    return NextResponse.json({ error: 'Failed to fetch episodes' }, { status: 500 });
  }
}
