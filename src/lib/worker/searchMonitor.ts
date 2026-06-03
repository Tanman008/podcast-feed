// lib/worker/searchMonitor.ts
// Periodic polling for search-type sources — re-runs the expanded query set
// and queues any episodes not yet ingested.

import { db } from '@/lib/db';
import { expandSearchTerm } from '@/lib/ingestion/searchExpander';
import { fetchSearchEpisodes } from '@/lib/ingestion/searchIngestion';

export async function checkSearchForNewEpisodes(sourceId: string): Promise<number> {
  const source = await db.source.findUnique({
    where: { id: sourceId },
    select: { id: true, name: true, searchQuery: true, lastCheckedAt: true, minDurationSeconds: true },
  });
  if (!source?.searchQuery) return 0;

  let expansion;
  try {
    expansion = await expandSearchTerm(source.searchQuery);
  } catch (err: any) {
    console.error(`[SearchMonitor] ${source.name}: expand failed:`, err.message);
    return 0;
  }

  let episodes;
  try {
    episodes = await fetchSearchEpisodes(expansion, 20);
  } catch (err: any) {
    console.error(`[SearchMonitor] ${source.name}: fetch failed:`, err.message);
    return 0;
  }

  if (episodes.length === 0) {
    await db.source.update({ where: { id: sourceId }, data: { lastCheckedAt: new Date() } });
    return 0;
  }

  // Dedup: skip episodes already ingested for this source
  const existingIds = new Set(
    (await db.episode.findMany({
      where: { sourceId, externalId: { in: episodes.map(e => String(e.id)) } },
      select: { externalId: true },
    })).map(e => e.externalId)
  );

  // Also skip episodes published before our last check (not a backfill run)
  const lastChecked = source.lastCheckedAt;

  const minDurationSecs = source.minDurationSeconds ?? 20 * 60;

  let enqueued = 0;
  for (const ep of episodes) {
    const externalId = String(ep.id);
    if (existingIds.has(externalId)) continue;
    if (!ep.enclosureUrl) continue;
    if (ep.duration && ep.duration < minDurationSecs) continue;
    if (lastChecked && ep.datePublished && new Date(ep.datePublished * 1000) <= lastChecked) continue;

    const episode = await db.episode.upsert({
      where: { sourceId_externalId: { sourceId, externalId } },
      update: {},
      create: {
        sourceId,
        externalId,
        title:           ep.title || 'Untitled Episode',
        description:     ep.description || null,
        publishedAt:     ep.datePublished ? new Date(ep.datePublished * 1000) : null,
        durationSeconds: ep.duration || null,
        thumbnailUrl:    ep.image || null,
        transcriptStatus: 'pending',
      },
    });

    await db.ingestionJob.create({
      data: {
        episodeUrl: ep.enclosureUrl,
        sourceId,
        episodeId:  episode.id,
        status:     'queued',
      },
    });
    enqueued++;
  }

  await db.source.update({ where: { id: sourceId }, data: { lastCheckedAt: new Date() } });
  if (enqueued > 0) {
    console.log(`[SearchMonitor] ${source.name}: enqueued ${enqueued} new episode(s)`);
  }
  return enqueued;
}

export async function pollAllSearches(): Promise<void> {
  const now = new Date();
  const sources = await db.source.findMany({
    where: { sourceType: 'search', following: true },
    select: { id: true, name: true, checkIntervalHours: true, lastCheckedAt: true },
  });

  for (const source of sources) {
    const intervalMs = source.checkIntervalHours * 60 * 60 * 1000;
    const lastChecked = source.lastCheckedAt?.getTime() ?? 0;
    if (now.getTime() - lastChecked < intervalMs) continue;

    try {
      await checkSearchForNewEpisodes(source.id);
    } catch (err: any) {
      console.warn(`[SearchMonitor] ${source.name}: check failed:`, err.message);
    }
  }
}
