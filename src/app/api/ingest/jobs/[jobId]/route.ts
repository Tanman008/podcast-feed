// src/app/api/ingest/jobs/[jobId]/route.ts
// GET /api/ingest/jobs/[jobId] - poll ingestion job status
// Client polls this to get progress 0-100 and status

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;

    if (!jobId || typeof jobId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid job ID' },
        { status: 400 }
      );
    }

    const job = await db.ingestionJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return NextResponse.json(
        { error: 'Job not found' },
        { status: 404 }
      );
    }

    // Return current job status
    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      chunksTotal: job.chunksTotal,
      chunksDone: job.chunksDone,
      episodeId: job.episodeId,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  } catch (error: any) {
    console.error('[API] Job status error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch job status' },
      { status: 500 }
    );
  }
}
