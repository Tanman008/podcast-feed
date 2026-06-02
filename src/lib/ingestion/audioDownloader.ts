// lib/ingestion/audioDownloader.ts
// Downloads YouTube audio to a temp file via yt-dlp.
// Caller must call cleanup() after transcription to free disk space.

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);

export interface AudioFile {
  path: string;
  cleanup: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fast metadata-only call — no audio downloaded, no Deepgram cost.
// Returns duration and upload date in a single yt-dlp invocation.
export async function fetchVideoInfo(videoId: string): Promise<{ durationSeconds: number | null; uploadDate: Date | null }> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const { stdout } = await execAsync(
      `yt-dlp --print "%(duration)s %(upload_date)s" --no-playlist --js-runtimes "node:${process.execPath}" "${url}"`,
      { timeout: 30_000 }
    );
    const parts = stdout.trim().split(' ');
    const durationSeconds = parseFloat(parts[0]);
    let uploadDate: Date | null = null;
    const d = parts[1];
    if (d && /^\d{8}$/.test(d)) {
      uploadDate = new Date(parseInt(d.slice(0, 4)), parseInt(d.slice(4, 6)) - 1, parseInt(d.slice(6, 8)));
    }
    return { durationSeconds: isNaN(durationSeconds) ? null : durationSeconds, uploadDate };
  } catch {
    return { durationSeconds: null, uploadDate: null };
  }
}

// Back-compat wrapper for callers that only need duration.
export async function fetchVideoDurationSeconds(videoId: string): Promise<number | null> {
  return (await fetchVideoInfo(videoId)).durationSeconds;
}

export async function downloadAudio(videoId: string): Promise<AudioFile> {
  const outputPath = path.join(os.tmpdir(), `podcast-${videoId}.m4a`);

  // Clean up any stale file from a previous failed run
  try { fs.unlinkSync(outputPath); } catch {}

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Retry with backoff on 429. yt-dlp exits non-zero on 429 and includes it in stderr.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await execAsync(
        `yt-dlp -f "bestaudio[ext=m4a]" --no-playlist --js-runtimes "node:${process.execPath}" -o "${outputPath}" "${url}"`,
        { timeout: 600_000 }
      );
      break;
    } catch (err: any) {
      const msg: string = err?.stderr ?? err?.message ?? '';
      const is429 = msg.includes('429') || msg.includes('Too Many Requests');
      if (is429 && attempt < maxAttempts) {
        const delaySec = 15 * attempt; // 15s, 30s
        console.warn(`[audioDownloader] 429 on attempt ${attempt}, retrying in ${delaySec}s`);
        await sleep(delaySec * 1000);
        continue;
      }
      throw err;
    }
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error(`yt-dlp completed but output file not found: ${outputPath}`);
  }

  return {
    path: outputPath,
    cleanup: () => { try { fs.unlinkSync(outputPath); } catch {} },
  };
}
