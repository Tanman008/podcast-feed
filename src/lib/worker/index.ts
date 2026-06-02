// lib/worker/index.ts
// Ingestion worker: polls every 5s for jobs and processes them
// Run with: npm run worker
// Graceful shutdown on SIGTERM

import { claimNextJob } from './claim';
import { processJob } from './processJob';
import { pollAllChannels } from './rssMonitor';

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

async function startWorker(): Promise<void> {
  console.log('[Worker] Starting ingestion worker...');
  console.log(`[Worker] Job poll: every ${POLL_INTERVAL_MS / 1000}s | RSS poll: every ${RSS_INTERVAL_MS / 60000}min | Max concurrent: ${MAX_CONCURRENT_JOBS}`);

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
