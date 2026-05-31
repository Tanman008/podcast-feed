// lib/worker/index.ts
// Ingestion worker: polls every 5s for jobs and processes them
// Run with: npm run worker
// Graceful shutdown on SIGTERM

import { claimNextJob } from './claim';
import { processJob } from './processJob';

const POLL_INTERVAL_MS = 5000; // 5 seconds

let isRunning = true;
let isProcessing = false;

async function pollAndProcess(): Promise<void> {
  if (isProcessing) {
    return; // Already processing a job
  }

  try {
    isProcessing = true;

    const job = await claimNextJob();

    if (!job) {
      // No jobs available, will retry on next poll
      return;
    }

    console.log(`[Worker] Processing job ${job.id}`);
    await processJob(job);
  } catch (error) {
    console.error('[Worker] Error during poll/process:', error);
  } finally {
    isProcessing = false;
  }
}

async function startWorker(): Promise<void> {
  console.log('[Worker] Starting ingestion worker...');
  console.log(`[Worker] Polling every ${POLL_INTERVAL_MS}ms for jobs`);

  // Poll loop
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

    // Wait for current job to complete (max 5 minutes)
    let waited = 0;
    while (isProcessing && waited < 300000) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      waited += 1000;
    }

    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[Worker] SIGINT received, shutting down gracefully...');
    isRunning = false;

    let waited = 0;
    while (isProcessing && waited < 300000) {
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
