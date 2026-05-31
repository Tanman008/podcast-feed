// src/app/api/search/route.ts
// GET /api/search - semantic search for chunks
// Query: q (search text), limit, optional ticker filter

import { NextRequest, NextResponse } from 'next/server';
import { semanticSearch } from '@/lib/retrieval/search';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;

    const q = searchParams.get('q');
    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 100);
    const tickerFilter = searchParams.get('ticker');

    if (!q || q.trim().length === 0) {
      return NextResponse.json(
        { error: 'Query parameter "q" is required' },
        { status: 400 }
      );
    }

    // Perform semantic search
    const chunks = await semanticSearch(q, {
      limit,
      tickerFilter: tickerFilter ? [tickerFilter] : undefined,
    });

    // Format response
    return NextResponse.json({
      query: q,
      total: chunks.length,
      chunks: chunks.map(chunk => ({
        id: chunk.id,
        text: chunk.text,
        startTimeSeconds: chunk.startTimeSeconds,
        endTimeSeconds: chunk.endTimeSeconds,
        noveltyScore: chunk.noveltyScore,
        convictionScore: chunk.convictionScore,
        speaker: chunk.speaker ? {
          id: chunk.speaker.id,
          name: chunk.speaker.name,
        } : null,
        episode: chunk.episode ? {
          id: chunk.episode.id,
          title: chunk.episode.title,
          publishedAt: chunk.episode.publishedAt,
          source: chunk.episode.source ? {
            name: chunk.episode.source.name,
            platform: chunk.episode.source.platform,
          } : null,
        } : null,
      })),
    });
  } catch (error: any) {
    console.error('[API] Search error:', error);
    return NextResponse.json(
      { error: 'Search failed' },
      { status: 500 }
    );
  }
}
