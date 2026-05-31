// lib/worker/claim.ts
// Atomic job claiming via FOR UPDATE SKIP LOCKED
// Enables safe multi-worker deployments without external queue service

import { db } from '@/lib/db';
import { IngestionJob, JobStatus } from '@prisma/client';

// Claim the next queued job atomically
// Returns null if no jobs available (or all are being processed by other workers)
export async function claimNextJob(): Promise<IngestionJob | null> {
  try {
    // Use raw SQL for atomic claiming with FOR UPDATE SKIP LOCKED
    // This pattern is safe for multiple workers
    const result = await db.$queryRaw<IngestionJob[]>`
      UPDATE "IngestionJob"
      SET status = 'running'::"JobStatus", "startedAt" = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM "IngestionJob"
        WHERE status = 'queued'::"JobStatus"
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
    `;

    return result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error('[Worker] Error claiming job:', error);
    return null;
  }
}

// Mark job as completed
export async function completeJob(jobId: string, episodeId?: string): Promise<void> {
  await db.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: 'completed' as JobStatus,
      progress: 100,
      completedAt: new Date(),
      episodeId: episodeId || undefined,
    },
  });
}

// Mark job as failed with error message
export async function failJob(jobId: string, errorMessage: string): Promise<void> {
  await db.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: 'failed' as JobStatus,
      errorMessage: errorMessage.slice(0, 500), // Truncate to DB field limit
      completedAt: new Date(),
    },
  });
}

// Update job progress during processing
export async function updateJobProgress(
  jobId: string,
  progress: number,
  chunksDone?: number,
  chunksTotal?: number
): Promise<void> {
  const update: any = {
    progress: Math.max(0, Math.min(100, progress)),
  };

  if (chunksDone !== undefined) {
    update.chunksDone = chunksDone;
  }

  if (chunksTotal !== undefined) {
    update.chunksTotal = chunksTotal;
  }

  await db.ingestionJob.update({
    where: { id: jobId },
    data: update,
  });
}
