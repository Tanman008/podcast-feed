// lib/worker/rssMonitor.ts
// Polls podcast RSS feeds directly — bypasses Podcast Index crawl lag.
// RSS feeds update the moment a new episode publishes; PI may lag hours/days.

import { db } from '@/lib/db';
import { fetchRSSEpisodes } from '@/lib/ingestion/rssParser';

interface CheckOptions {
  backfillCount?: number;
}

export async function checkPodcastForNewEpisodes(
  sourceId: string,
  options: CheckOptions = {}
): Promise<number> {
  const source = await db.source.findUnique({
    where: { id: sourceId },
    select: {
      id: true, name: true, url: true, feedUrl: true,
      minDurationSeconds: true, maxDurationSeconds: true,
      lastCheckedAt: true,
    },
  });
  if (!source) return 0;

  const feedUrl = (source as any).feedUrl as string | null;
  if (!feedUrl) {
    console.warn(`[Monitor] ${source.name}: no feedUrl set, skipping RSS poll`);
    return 0;
  }

  let allEpisodes: Awaited<ReturnType<typeof fetchRSSEpisodes>>;
  try {
    allEpisodes = await fetchRSSEpisodes(feedUrl);
  } catch (err: any) {
    console.error(`[Monitor] ${source.name}: RSS fetch failed:`, err.message);
    return 0;
  }

  const minSecs = source.minDurationSeconds ?? null;
  const maxSecs = source.maxDurationSeconds ?? null;

  // Apply duration filter
  const filtered = allEpisodes.filter(ep => {
    if (minSecs !== null && ep.durationSecs !== null && ep.durationSecs < minSecs) return false;
    if (maxSecs !== null && ep.durationSecs !== null && ep.durationSecs > maxSecs) return false;
    return true;
  });

  const backfillCount = options.backfillCount;
  const candidates = backfillCount ? filtered.slice(0, backfillCount) : filtered;

  // Find which GUIDs are already in DB for this source
  const existingGuids = new Set(
    (await db.episode.findMany({
      where: { sourceId, externalId: { in: candidates.map(e => e.guid) } },
      select: { externalId: true },
    })).map(e => e.externalId)
  );

  const toEnqueue = backfillCount
    ? candidates.filter(e => !existingGuids.has(e.guid))
    : candidates.filter(e => {
        if (existingGuids.has(e.guid)) return false;
        if (source.lastCheckedAt && e.publishedAt && e.publishedAt <= source.lastCheckedAt) return false;
        return true;
      });

  let enqueued = 0;
  for (const ep of toEnqueue) {
    // Pre-create the Episode so processJob has title/date without needing a PI lookup.
    // Uses guid as externalId so deduplication works correctly.
    const episode = await db.episode.upsert({
      where: { sourceId_externalId: { sourceId, externalId: ep.guid } },
      update: {},
      create: {
        sourceId,
        externalId:      ep.guid,
        title:           ep.title || 'Untitled Episode',
        publishedAt:     ep.publishedAt,
        durationSeconds: ep.durationSecs ?? null,
        transcriptStatus: 'pending',
      },
    });

    await db.ingestionJob.create({
      data: {
        episodeUrl: ep.audioUrl,
        sourceId,
        episodeId: episode.id,
        status: 'queued',
      },
    });
    enqueued++;
  }

  await db.source.update({ where: { id: sourceId }, data: { lastCheckedAt: new Date() } });
  if (enqueued > 0) {
    console.log(`[Monitor] ${source.name}: enqueued ${enqueued} new episode(s)`);
  }
  return enqueued;
}

// Alias for backward compatibility with channels API route
export const checkChannelForNewVideos = checkPodcastForNewEpisodes;

export async function pollAllChannels(): Promise<void> {
  const now = new Date();
  const sources = await db.source.findMany({
    where: { following: true },
    select: { id: true, name: true, checkIntervalHours: true, lastCheckedAt: true },
  });

  for (const source of sources) {
    const intervalMs = source.checkIntervalHours * 60 * 60 * 1000;
    const lastChecked = source.lastCheckedAt?.getTime() ?? 0;
    if (now.getTime() - lastChecked < intervalMs) continue;

    try {
      await checkPodcastForNewEpisodes(source.id);
    } catch (err: any) {
      console.warn(`[Monitor] ${source.name}: check failed:`, err.message);
    }
  }
}
