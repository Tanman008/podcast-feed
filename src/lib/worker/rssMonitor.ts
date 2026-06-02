import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from '@/lib/db';
import { fetchChannelFeed } from '@/lib/youtube/channels';

const execFileAsync = promisify(execFile);

function extractChannelId(url: string): string | null {
  return url.match(/youtube\.com\/channel\/(UC[\w-]+)/)?.[1] ?? null;
}

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
): Promise<{ videoId: string }[]> {
  const args: string[] = [
    '--flat-playlist',
    '--print', '%(id)s %(duration)s',
    '--playlist-end', '500',
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

  const entries: { videoId: string }[] = [];
  for (const line of stdout.split('\n')) {
    if (entries.length >= count) break;

    const parts = line.trim().split(/\s+/);
    const videoId = parts[0];
    if (!videoId || videoId === 'NA') continue;

    const duration = parseFloat(parts[1]);
    if (isNaN(duration)) continue; // flat-playlist may omit duration for some videos — skip
    if (minSecs !== null && duration < minSecs) continue;
    if (maxSecs !== null && duration > maxSecs) continue;

    entries.push({ videoId });
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

  const channelId = extractChannelId(source.url);
  if (!channelId) {
    console.log(`[RSS] ${source.name}: no channel ID in URL, skipping`);
    return 0;
  }

  // Backfill (backfillCount > 0): use yt-dlp so we can go beyond the ~15 RSS cap.
  // Ongoing monitoring (no backfillCount): use RSS — faster, no process spawn.
  interface VideoToEnqueue {
    videoId: string;
    publishedAt?: Date;
  }
  let videosToEnqueue: VideoToEnqueue[];

  if (options.backfillCount && options.backfillCount > 0) {
    try {
      const entries = await listVideosViaYtdlp(
        source.url,
        options.backfillCount,
        source.minDurationSeconds,
        source.maxDurationSeconds
      );
      videosToEnqueue = entries.map(e => ({ videoId: e.videoId }));
      console.log(`[Backfill] ${source.name}: yt-dlp found ${videosToEnqueue.length} videos in length range`);
    } catch (err) {
      console.warn(`[Backfill] ${source.name}: yt-dlp failed, falling back to RSS:`, err);
      const rssEntries = await fetchChannelFeed(channelId);
      videosToEnqueue = rssEntries.map(e => ({ videoId: e.videoId, publishedAt: e.published }));
    }
  } else {
    const rssEntries = await fetchChannelFeed(channelId);
    videosToEnqueue = rssEntries.map(e => ({ videoId: e.videoId, publishedAt: e.published }));
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
