import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from '@/lib/db';

const execFileAsync = promisify(execFile);

interface CheckOptions {
  backfillCount?: number;
}

// Use yt-dlp to list channel videos — bypasses the RSS ~15-item cap.
// Prints "videoId durationSeconds" per line; filters by min/max duration.
// Returns up to `count` videos that fall within the length range.
async function listVideosViaYtdlp(
  channelUrl: string,
  count: number,
  minSecs: number | null,
  maxSecs: number | null
): Promise<{ videoId: string; publishedAt?: Date }[]> {
  const playlistEnd = Math.min(count * 4, 500); // over-fetch to account for filtered videos
  const args: string[] = [
    '--flat-playlist',
    '--print', '%(id)s %(duration)s %(timestamp)s',
    '--playlist-end', String(playlistEnd),
    '--no-warnings',
    '--quiet',
    `${channelUrl}/videos`,
  ];

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('yt-dlp', args, { timeout: 120_000 }));
  } catch (err: any) {
    stdout = err.stdout ?? '';
    if (!stdout.trim()) throw new Error(`yt-dlp failed: ${err.message}`);
  }

  const entries: { videoId: string; publishedAt?: Date }[] = [];
  for (const line of stdout.split('\n')) {
    if (entries.length >= count) break;

    const parts = line.trim().split(/\s+/);
    const videoId = parts[0];
    if (!videoId || videoId === 'NA') continue;

    const duration = parseFloat(parts[1]);
    if (isNaN(duration)) continue;
    if (minSecs !== null && duration < minSecs) continue;
    if (maxSecs !== null && duration > maxSecs) continue;

    const ts = parseInt(parts[2]);
    const publishedAt = !isNaN(ts) && ts > 0 ? new Date(ts * 1000) : undefined;

    entries.push({ videoId, publishedAt });
  }

  return entries;
}

export async function checkChannelForNewVideos(
  sourceId: string,
  options: CheckOptions = {}
): Promise<number> {
  const source = await db.source.findUnique({
    where: { id: sourceId },
    select: { id: true, name: true, url: true, minDurationSeconds: true, maxDurationSeconds: true, createdAt: true, lastCheckedAt: true },
  });
  if (!source) return 0;

  // yt-dlp handles all URL formats: /channel/UC..., /@handle, /c/name
  const count = options.backfillCount && options.backfillCount > 0 ? options.backfillCount : 15;
  let videosToEnqueue: { videoId: string; publishedAt?: Date }[];

  try {
    videosToEnqueue = await listVideosViaYtdlp(
      source.url,
      count,
      source.minDurationSeconds,
      source.maxDurationSeconds
    );
    console.log(`[Monitor] ${source.name}: yt-dlp found ${videosToEnqueue.length} videos`);
  } catch (err) {
    console.warn(`[Monitor] ${source.name}: yt-dlp failed, skipping:`, err);
    return 0;
  }

  let enqueued = 0;

  // For ongoing monitoring (no backfill), only pick up videos published after this source was added.
  // Prevents ingesting the channel's entire back-catalogue on every check.
  const monitoringCutoff = options.backfillCount ? null : (source.lastCheckedAt ?? source.createdAt);

  for (const { videoId, publishedAt } of videosToEnqueue) {
    if (monitoringCutoff && (!publishedAt || publishedAt < monitoringCutoff)) continue;

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const alreadyIngested = await db.episode.findFirst({
      where: { externalId: videoId },
      select: { id: true },
    });
    if (alreadyIngested) continue;

    const alreadyQueued = await db.ingestionJob.findFirst({
      where: { videoUrl: { contains: videoId }, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (alreadyQueued) continue;

    // Pre-set the publish date from RSS before the job runs so processJob.ts doesn't overwrite it with new Date()
    if (publishedAt) {
      await db.episode.upsert({
        where: { sourceId_externalId: { sourceId: source.id, externalId: videoId } },
        update: { publishedAt },
        create: {
          sourceId: source.id,
          externalId: videoId,
          title: `Video ${videoId}`,
          publishedAt,
          transcriptStatus: 'pending',
        },
      });
    }

    await db.ingestionJob.create({ data: { videoUrl, sourceId: source.id, status: 'queued' } });
    console.log(`[Monitor] Enqueued "${videoId}" from ${source.name}`);
    enqueued++;
  }

  await db.source.update({
    where: { id: sourceId },
    data: { lastCheckedAt: new Date() },
  });

  return enqueued;
}

export async function pollAllChannels(): Promise<void> {
  const sources = await db.source.findMany({
    where: { platform: 'youtube', following: true },
    select: { id: true, checkIntervalHours: true, lastCheckedAt: true },
  });

  for (const source of sources) {
    const intervalMs = source.checkIntervalHours * 60 * 60 * 1000;
    const lastChecked = source.lastCheckedAt?.getTime() ?? 0;
    if (Date.now() - lastChecked >= intervalMs) {
      await checkChannelForNewVideos(source.id);
    }
  }
}
