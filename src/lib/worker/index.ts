// lib/worker/index.ts
// Ingestion worker: polls every 5s for jobs and processes them
// Run with: npm run worker
// Graceful shutdown on SIGTERM

import { claimNextJob } from './claim';
import { processJob } from './processJob';
import { pollAllChannels } from './rssMonitor';
import { db } from '@/lib/db';

const POLL_INTERVAL_MS    = 5_000;        // job poll: every 5s
const RSS_INTERVAL_MS     = 30 * 60_000; // RSS poll: every 30 min
const MAX_CONCURRENT_JOBS = 2;

let isRunning  = true;
let activeJobs = 0;

async function pollAndProcess(): Promise<void> {
  if (activeJobs >= MAX_CONCURRENT_JOBS) return;

  let job;
  try {
    job = await claimNextJob();
  } catch (error) {
    console.error('[Worker] Error claiming job:', error);
    return;
  }

  if (!job) return;

  activeJobs++;
  console.log(`[Worker] Processing job ${job.id} (${activeJobs}/${MAX_CONCURRENT_JOBS} active)`);

  processJob(job)
    .catch(error => console.error(`[Worker] Job ${job.id} error:`, error))
    .finally(() => { activeJobs--; });
}

// On startup, any job that was 'running' when the previous process was killed
// will never be retried. Clean them up: fail the job and delete the orphaned episode.
async function cleanupStaleJobs(): Promise<void> {
  const stale = await db.ingestionJob.findMany({
    where: { status: 'running' },
    select: { id: true, episodeId: true },
  });

  if (stale.length === 0) return;
  console.log(`[Worker] Cleaning up ${stale.length} stale job(s) from previous process...`);

  for (const job of stale) {
    try {
      if (job.episodeId) {
        await db.chunkEntity.deleteMany({ where: { chunk: { episodeId: job.episodeId } } });
        await db.claim.deleteMany({ where: { chunk: { episodeId: job.episodeId } } });
        await db.transcriptChunk.deleteMany({ where: { episodeId: job.episodeId } });
        await db.episode.deleteMany({ where: { id: job.episodeId } });
      }
      await db.ingestionJob.update({
        where: { id: job.id },
        data: { status: 'failed', errorMessage: 'Worker restarted mid-job' },
      });
      console.log(`[Worker] Cleaned up stale job ${job.id}`);
    } catch (err) {
      console.warn(`[Worker] Failed to clean up job ${job.id}:`, err);
    }
  }
}

async function startWorker(): Promise<void> {
  console.log('[Worker] Starting ingestion worker...');
  console.log(`[Worker] Job poll: every ${POLL_INTERVAL_MS / 1000}s | RSS poll: every ${RSS_INTERVAL_MS / 60000}min | Max concurrent: ${MAX_CONCURRENT_JOBS}`);

  await cleanupStaleJobs();

  // RSS monitor — run once on start, then on interval
  pollAllChannels().catch(e => console.error('[RSS] Initial poll failed:', e));
  setInterval(() => {
    pollAllChannels().catch(e => console.error('[RSS] Poll failed:', e));
  }, RSS_INTERVAL_MS);

  // Job poll loop
  while (isRunning) {
    await pollAndProcess();
    if (isRunning) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  console.log('[Worker] Shutdown complete');
}

// Graceful shutdown
function setupShutdown(): void {
  process.on('SIGTERM', async () => {
    console.log('[Worker] SIGTERM received, shutting down gracefully...');
    isRunning = false;

    // Wait for active jobs to complete (max 5 minutes)
    let waited = 0;
    while (activeJobs > 0 && waited < 300000) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      waited += 1000;
    }

    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[Worker] SIGINT received, shutting down gracefully...');
    isRunning = false;

    let waited = 0;
    while (activeJobs > 0 && waited < 300000) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      waited += 1000;
    }

    process.exit(0);
  });
}

// Main
setupShutdown();
startWorker().catch(error => {
  console.error('[Worker] Fatal error:', error);
  process.exit(1);
});
