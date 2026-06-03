// Fetches recent podcast episodes for a search term via Podcast Index.
// PI has no per-episode keyword search — instead we search for relevant feeds
// by entityName, then pull recent episodes from each feed.

import { searchPodcasts, getEpisodes } from '@/lib/podcast-index/client';
import type { PIEpisode } from '@/lib/podcast-index/types';
import type { SearchExpansion } from './searchExpander';

export async function fetchSearchEpisodes(
  expansion: SearchExpansion,
  maxTotal = 10
): Promise<PIEpisode[]> {
  // Search for podcasts whose name/description matches the entity.
  // Using entityName (e.g. "NVIDIA", "Jensen Huang") gives much better feed
  // recall than the specific query strings, which are too narrow for feed search.
  const feeds = await searchPodcasts(expansion.entityName).catch(() => []);

  if (feeds.length === 0) return [];

  // Fetch recent episodes from the top matching feeds in parallel.
  // Cap at 10 feeds to avoid excessive API calls; 2 episodes each = up to 20 candidates.
  const results = await Promise.allSettled(
    feeds.slice(0, 10).map(f => getEpisodes(f.id, 2))
  );

  const seen = new Set<number>();
  const merged: PIEpisode[] = [];

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const ep of r.value) {
      if (!ep.enclosureUrl || seen.has(ep.id)) continue;
      seen.add(ep.id);
      merged.push(ep);
    }
  }

  merged.sort((a, b) => b.datePublished - a.datePublished);
  return merged.slice(0, maxTotal);
}
