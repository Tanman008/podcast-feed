// Fetches recent podcast episodes for a search term via Podcast Index.
// Strategy depends on inputType:
//   person → search/byperson endpoint (episode-level person tagging)
//   company/theme/product/event → search feeds by feedTerms, get recent episodes from each

import { searchPodcasts, getEpisodes, getPodcastByItunesId, searchItunesEpisodes } from '@/lib/podcast-index/client';
import type { PIEpisode } from '@/lib/podcast-index/types';
import type { SearchExpansion } from './searchExpander';

async function fetchPersonEpisodes(personName: string): Promise<PIEpisode[]> {
  const AI_FARM_RE = /biography\s+flash|quiet\.\s*please|inception\s+point\s+ai/i;
  const nameTokens = personName.toLowerCase().split(/\s+/);

  const itunesEps = await searchItunesEpisodes(personName, 20).catch(() => []);

  const uniqueCollectionIds = [...new Set(itunesEps.map(e => e.collectionId))];
  const piFeeds = await Promise.allSettled(uniqueCollectionIds.map(id => getPodcastByItunesId(id)));
  const feedByCollectionId = new Map<number, { feedId: number; feedUrl: string; feedTitle: string }>();
  uniqueCollectionIds.forEach((collId, i) => {
    const r = piFeeds[i];
    if (r.status === 'fulfilled' && r.value) {
      feedByCollectionId.set(collId, { feedId: r.value.id, feedUrl: r.value.feedUrl, feedTitle: r.value.title });
    }
  });

  const seen = new Set<number>();
  const results: PIEpisode[] = [];
  for (const ep of itunesEps) {
    if (seen.has(ep.trackId)) continue;
    seen.add(ep.trackId);
    if (AI_FARM_RE.test(ep.collectionName ?? '')) continue;
    if (!nameTokens.some(tok => ep.trackName.toLowerCase().includes(tok))) continue;
    const feed = feedByCollectionId.get(ep.collectionId);
    results.push({
      id:            ep.trackId,
      guid:          String(ep.trackId),
      feedId:        feed?.feedId ?? 0,
      feedTitle:     feed?.feedTitle ?? ep.collectionName,
      feedUrl:       feed?.feedUrl ?? '',
      title:         ep.trackName,
      description:   ep.description ?? '',
      datePublished: Math.floor(new Date(ep.releaseDate).getTime() / 1000),
      duration:      Math.floor((ep.trackTimeMillis ?? 0) / 1000),
      enclosureUrl:  ep.episodeUrl,
      image:         ep.artworkUrl600 ?? '',
    });
  }
  return results;
}

async function fetchByFeedTerms(feedTerms: string[], entityName: string, max: number): Promise<PIEpisode[]> {
  const searchTerms = feedTerms.length ? [entityName, ...feedTerms] : [entityName];

  const feedSearches = await Promise.allSettled(searchTerms.map(q => searchPodcasts(q)));

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
  return merged.slice(0, max);
}

export async function fetchSearchEpisodes(
  expansion: SearchExpansion,
  maxTotal = 20,
  sinceTimestamp?: number        // Unix seconds — filter out episodes older than this
): Promise<PIEpisode[]> {
  if (expansion.inputType === 'person') {
    const results = await fetchPersonEpisodes(expansion.entityName);
    const filtered = sinceTimestamp ? results.filter(e => e.datePublished >= sinceTimestamp) : results;
    filtered.sort((a, b) => b.datePublished - a.datePublished);
    return filtered.slice(0, maxTotal);
  }

  // For company/theme/product/event: feed-based search + C-suite iTunes searches in parallel.
  const feedTerms = expansion.feedTerms?.length ? expansion.feedTerms : [];
  const people    = expansion.relatedPeople ?? [];

  const [feedEpisodes, ...peopleResults] = await Promise.all([
    fetchByFeedTerms(feedTerms, expansion.entityName, maxTotal),
    ...people.map(name => fetchPersonEpisodes(name)),
  ]);

  // Merge, dedup by episode id, sort by recency
  const seen = new Set<number>(feedEpisodes.map(e => e.id));
  const merged = [...feedEpisodes];
  for (const personEps of peopleResults) {
    for (const ep of personEps) {
      if (!seen.has(ep.id)) { seen.add(ep.id); merged.push(ep); }
    }
  }

  merged.sort((a, b) => b.datePublished - a.datePublished);
  const capped = merged.slice(0, maxTotal * 2); // allow more when C-suite adds volume
  return sinceTimestamp ? capped.filter(e => e.datePublished >= sinceTimestamp) : capped;
}
