// Fetches recent podcast episodes for a search term via Podcast Index.
// Strategy depends on inputType:
//   person → search/byperson endpoint (episode-level person tagging)
//   company/theme/product/event → search feeds by feedTerms, get recent episodes from each

import { searchPodcasts, getEpisodes, searchEpisodesByPerson } from '@/lib/podcast-index/client';
import type { PIEpisode } from '@/lib/podcast-index/types';
import type { SearchExpansion } from './searchExpander';

export async function fetchSearchEpisodes(
  expansion: SearchExpansion,
  maxTotal = 10
): Promise<PIEpisode[]> {
  if (expansion.inputType === 'person') {
    // PI's search/byperson endpoint returns episodes tagged with the person's name —
    // actual interviews and episodes where they appear, not just shows about them.
    const episodes = await searchEpisodesByPerson(expansion.entityName).catch(() => []);
    return episodes.slice(0, maxTotal);
  }

  // For company/theme/product/event: search for relevant feeds by feedTerms,
  // then get recent episodes from each matching feed.
  const searchTerms = expansion.feedTerms?.length
    ? [expansion.entityName, ...expansion.feedTerms]
    : [expansion.entityName];

  const feedSearches = await Promise.allSettled(
    searchTerms.map(q => searchPodcasts(q))
  );

  const feedMap = new Map<number, { id: number }>();
  for (const r of feedSearches) {
    if (r.status !== 'fulfilled') continue;
    for (const f of r.value) {
      if (!feedMap.has(f.id)) feedMap.set(f.id, f);
    }
  }

  const feeds = [...feedMap.values()];
  if (feeds.length === 0) return [];

  const episodeFetches = await Promise.allSettled(
    feeds.slice(0, 15).map(f => getEpisodes(f.id, 2))
  );

  const seen = new Set<number>();
  const merged: PIEpisode[] = [];

  for (const r of episodeFetches) {
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
