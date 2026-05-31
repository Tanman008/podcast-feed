// src/app/api/ingest/youtube/route.ts
// POST /api/ingest/youtube - enqueue ingestion job
// Returns immediately with jobId (worker does the actual work)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { extractVideoId } from '@/lib/ingestion/youtube';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { videoUrl, sourceId } = body;

    // Validate input
    if (!videoUrl || !sourceId) {
      return NextResponse.json(
        { error: 'Missing required fields: videoUrl, sourceId' },
        { status: 400 }
      );
    }

    if (typeof videoUrl !== 'string' || typeof sourceId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid field types' },
        { status: 400 }
      );
    }

    // Extract and validate video ID
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return NextResponse.json(
        { error: 'Invalid YouTube URL' },
        { status: 400 }
      );
    }

    // Verify source exists
    const source = await db.source.findUnique({
      where: { id: sourceId },
    });

    if (!source) {
      return NextResponse.json(
        { error: 'Source not found' },
        { status: 404 }
      );
    }

    // Create ingestion job
    const job = await db.ingestionJob.create({
      data: {
        videoUrl,
        sourceId,
        status: 'queued',
      },
    });

    console.log(`[API] Ingestion job enqueued: ${job.id}`);

    // Return immediately with jobId
    return NextResponse.json(
      {
        jobId: job.id,
        status: 'queued',
        message: 'Job enqueued. Poll /api/ingest/jobs/{jobId} for progress.',
      },
      { status: 202 } // Accepted
    );
  } catch (error: any) {
    console.error('[API] Ingestion error:', error);
    return NextResponse.json(
      { error: 'Failed to create ingestion job' },
      { status: 500 }
    );
  }
}
