// src/app/api/feed/[ticker]/route.ts
// GET /api/feed/[ticker] - retrieve chunks for a ticker
// Supports sorting, filtering by speaker, date range

import { NextRequest, NextResponse } from 'next/server';
import { getTickerFeed, shouldShowSpeakerFilter, getTickerSpeakers } from '@/lib/retrieval/search';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await params;
    const { searchParams } = request.nextUrl;

    // Parse query parameters
    const sort = (searchParams.get('sort') || 'recency') as 'recency' | 'novelty' | 'conviction';
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0'), 0);
    const speakerId = searchParams.get('speakerId') || undefined;

    // Parse date range if provided
    let dateRange: { from: Date; to: Date } | undefined;
    const fromStr = searchParams.get('from');
    const toStr = searchParams.get('to');
    if (fromStr && toStr) {
      dateRange = { from: new Date(fromStr), to: new Date(toStr) };
    }

    // Validate sort parameter
    if (!['recency', 'novelty', 'conviction'].includes(sort)) {
      return NextResponse.json(
        { error: 'Invalid sort parameter' },
        { status: 400 }
      );
    }

    // Get feed
    const { chunks, total } = await getTickerFeed(ticker, {
      sort,
      limit,
      offset,
      speakerId,
      dateRange,
    });

    if (total === 0) {
      return NextResponse.json({
        ticker,
        total: 0,
        chunks: [],
        speakers: [],
        showSpeakerFilter: false,
      });
    }

    // Check if speaker filter should be shown
    const showSpeakerFilter = await shouldShowSpeakerFilter(ticker);
    const speakers = showSpeakerFilter ? await getTickerSpeakers(ticker) : [];

    // Format response
    return NextResponse.json({
      ticker,
      total,
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
      speakers: speakers.map(s => ({
        id: s.id,
        name: s.name,
      })),
      showSpeakerFilter,
    });
  } catch (error: any) {
    console.error('[API] Feed error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch feed' },
      { status: 500 }
    );
  }
}
