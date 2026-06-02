// lib/worker/rssMonitor.ts
// Polls followed podcasts for new episodes via Podcast Index API.
// Replaces the yt-dlp flat-playlist approach — no yt-dlp dependency.

import { db } from '@/lib/db';
import { getEpisodes } from '@/lib/podcast-index/client';

interface CheckOptions {
  backfillCount?: number;
}

async function listRecentEpisodes(
  feedId: number,
  count: number,
  minSecs: number | null,
  maxSecs: number | null
): Promise<{ episodeUrl: string; publishedAt?: Date; externalId: string }[]> {
  // Over-fetch to account for duration filtering
  const episodes = await getEpisodes(feedId, Math.min(count * 4, 100));

  const filtered = episodes.filter(ep => {
    if (!ep.enclosureUrl) return false;
    if (minSecs !== null && ep.duration > 0 && ep.duration < minSecs) return false;
    if (maxSecs !== null && ep.duration > 0 && ep.duration > maxSecs) return false;
    return true;
  });

  return filtered.slice(0, count).map(ep => ({
    episodeUrl:  `https://podcastindex.org/podcast/${ep.feedId}/episode/${ep.id}`,
    externalId:  String(ep.id),
    publishedAt: ep.datePublished ? new Date(ep.datePublished * 1000) : undefined,
  }));
}

export async function checkPodcastForNewEpisodes(
  sourceId: string,
  options: CheckOptions = {}
): Promise<number> {
  const source = await db.source.findUnique({
    where: { id: sourceId },
    select: {
      id: true, name: true, url: true,
      minDurationSeconds: true, maxDurationSeconds: true,
      lastCheckedAt: true,
    },
  });
  if (!source) return 0;

  // feedId is stored as the Podcast Index URL: https://podcastindex.org/podcast/<feedId>
  const feedIdMatch = source.url.match(/podcastindex\.org\/podcast\/(\d+)/);
  if (!feedIdMatch) {
    console.warn(`[Monitor] ${source.name}: no feedId in URL "${source.url}", skipping`);
    return 0;
  }
  const feedId = parseInt(feedIdMatch[1], 10);

  const backfillCount = options.backfillCount;
  const count = backfillCount ?? 15;

  let episodes: { episodeUrl: string; publishedAt?: Date; externalId: string }[];
  try {
    episodes = await listRecentEpisodes(
      feedId, count,
      source.minDurationSeconds ?? null,
      source.maxDurationSeconds ?? null
    );
  } catch (err: any) {
    console.error(`[Monitor] ${source.name}: Podcast Index fetch failed:`, err.message);
    return 0;
  }

  if (episodes.length === 0) {
    await db.source.update({ where: { id: sourceId }, data: { lastCheckedAt: new Date() } });
    return 0;
  }

  // Find which externalIds already exist for this source
  const existingIds = new Set(
    (await db.episode.findMany({
      where: { sourceId, externalId: { in: episodes.map(e => e.externalId) } },
      select: { externalId: true },
    })).map(e => e.externalId)
  );

  const newEpisodes = backfillCount
    ? episodes.filter(e => !existingIds.has(e.externalId))
    : episodes.filter(e => {
        if (existingIds.has(e.externalId)) return false;
        // For monitoring (non-backfill), only pick up episodes newer than last check
        if (source.lastCheckedAt && e.publishedAt && e.publishedAt <= source.lastCheckedAt) return false;
        return true;
      });

  let enqueued = 0;
  for (const ep of newEpisodes) {
    await db.ingestionJob.create({
      data: { episodeUrl: ep.episodeUrl, sourceId, status: 'queued' },
    });
    enqueued++;
  }

  await db.source.update({ where: { id: sourceId }, data: { lastCheckedAt: new Date() } });
  if (enqueued > 0) {
    console.log(`[Monitor] ${source.name}: enqueued ${enqueued} new episode(s)`);
  }
  return enqueued;
}

// Alias used by channels API route
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
