// Fetches podcast episodes matching an expanded search term via Podcast Index.
// Runs all queries in parallel, deduplicates by episode ID, returns top N by recency.

import { searchEpisodes } from '@/lib/podcast-index/client';
import type { PIEpisode } from '@/lib/podcast-index/types';
import type { SearchExpansion } from './searchExpander';

export async function fetchSearchEpisodes(
  expansion: SearchExpansion,
  maxTotal = 10
): Promise<PIEpisode[]> {
  const results = await Promise.allSettled(
    expansion.queries.map(q => searchEpisodes(q, 10))
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

  // Sort by most recent first, return top N
  merged.sort((a, b) => b.datePublished - a.datePublished);
  return merged.slice(0, maxTotal);
}
