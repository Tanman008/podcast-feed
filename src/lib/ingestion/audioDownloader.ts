// lib/ingestion/audioDownloader.ts
// Downloads podcast audio directly from a CDN/RSS enclosure URL.
// No yt-dlp dependency — works for any public podcast audio URL.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

export interface AudioFile {
  path: string;
  cleanup: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function downloadToFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const timeout = 10 * 60 * 1000; // 10 minutes

    const req = protocol.get(url, { timeout }, (res) => {
      // Follow redirects (podcast CDNs redirect frequently)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, destPath).then(resolve, reject);
        return;
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} downloading audio from ${url}`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout downloading audio from ${url}`)); });
    req.on('error', reject);
  });
}

export async function downloadFromUrl(audioUrl: string, episodeId: string): Promise<AudioFile> {
  // Derive extension from URL, default to .mp3
  const ext = audioUrl.match(/\.(mp3|m4a|ogg|opus|aac|wav|flac)(\?|$)/i)?.[1] ?? 'mp3';
  const outputPath = path.join(os.tmpdir(), `podcast-${episodeId}.${ext}`);

  try { fs.unlinkSync(outputPath); } catch {}

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await downloadToFile(audioUrl, outputPath);
      break;
    } catch (err: any) {
      if (attempt < maxAttempts) {
        console.warn(`[audioDownloader] Download failed (attempt ${attempt}): ${err.message}, retrying in 5s`);
        await sleep(5_000);
        continue;
      }
      throw err;
    }
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Download completed but output file not found: ${outputPath}`);
  }

  return {
    path: outputPath,
    cleanup: () => { try { fs.unlinkSync(outputPath); } catch {} },
  };
}
