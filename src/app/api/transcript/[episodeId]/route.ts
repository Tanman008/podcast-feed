// src/app/api/transcript/[episodeId]/route.ts
// GET /api/transcript/[episodeId] - retrieve full transcript with all chunk metadata

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ episodeId: string }> }
) {
  try {
    const { episodeId } = await params;

    if (!episodeId || typeof episodeId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid episode ID' },
        { status: 400 }
      );
    }

    // Fetch episode
    const episode = await db.episode.findUnique({
      where: { id: episodeId },
      include: {
        source: true,
      },
    });

    if (!episode) {
      return NextResponse.json(
        { error: 'Episode not found' },
        { status: 404 }
      );
    }

    // Fetch all chunks for episode (ordered by chunkIndex)
    const chunks = await db.transcriptChunk.findMany({
      where: { episodeId },
      include: {
        speaker: true,
        entities: {
          include: {
            entity: true,
          },
        },
      },
      orderBy: { chunkIndex: 'asc' },
    });

    // Format response
    return NextResponse.json({
      episode: {
        id: episode.id,
        title: episode.title,
        description: episode.description,
        publishedAt: episode.publishedAt,
        durationSeconds: episode.durationSeconds,
        source: {
          name: episode.source.name,
          platform: episode.source.platform,
        },
      },
      chunks: chunks.map(chunk => ({
        id: chunk.id,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        startTimeSeconds: chunk.startTimeSeconds,
        endTimeSeconds: chunk.endTimeSeconds,
        tokenCount: chunk.tokenCount,
        noveltyScore: chunk.noveltyScore,
        convictionScore: chunk.convictionScore,
        speaker: chunk.speaker ? {
          id: chunk.speaker.id,
          name: chunk.speaker.name,
        } : null,
        entities: chunk.entities.map(ce => ({
          id: ce.entity.id,
          name: ce.entity.name,
          entityType: ce.entity.entityType,
          ticker: ce.entity.ticker,
          confidence: ce.confidence,
          mentionType: ce.mentionType,
        })),
      })),
    });
  } catch (error: any) {
    console.error('[API] Transcript error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch transcript' },
      { status: 500 }
    );
  }
}
