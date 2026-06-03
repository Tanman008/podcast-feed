// Fetches podcast episodes ABOUT a search term.
//
// Discovery strategy (rewritten):
//   PRIMARY  — iTunes episode search on the entity name + ticker + top queries.
//              This finds episodes whose title/description actually discuss the entity,
//              which is what an investor wants. Works without Podcast Index keys.
//   SECONDARY— Podcast Index feed-name search → recent episodes (additive; needs PI keys).
//   PEOPLE   — identity-safe C-suite search for company inputs. A person episode is only
//              kept if the company itself is referenced in the title/description/feed —
//              this prevents a same-named stranger (e.g. the UGG founder "Brian Smith"
//              vs a Coca-Cola exec) from polluting the feed.
//
// Every candidate from every channel is scored for relevance against the entity/query
// keyword set and filtered, so off-topic episodes from broad feed matches are dropped.

import { searchPodcasts, getEpisodes, getPodcastByItunesId, searchItunesEpisodes } from '@/lib/podcast-index/client';
import type { PIEpisode } from '@/lib/podcast-index/types';
import type { SearchExpansion } from './searchExpander';

// Auto-generated single-stock "farms" that recite earnings with no original analysis —
// exactly the low-signal content this product exists to filter out.
const AI_FARM_RE = /biography\s+flash|brand\s+biography|quiet\.\s*please|inception\s+point\s+ai|daily\s+ai|ai\s+chat\s+daily|beta\s*finch|ai\s+news\s+flash/i;

// Corporate suffixes and registry noise that pollute ticker-derived entity names.
// "Coca-Cola Company (The)" → "Coca-Cola"; "ASML Holding N.V. New York Registry Shares" → "ASML".
const CORP_STOPWORDS = new Set([
  'company', 'companies', 'corporation', 'corp', 'inc', 'incorporated', 'ltd', 'limited',
  'holding', 'holdings', 'plc', 'co', 'sa', 'ag', 'nv', 'the', 'group', 'class',
  'new', 'york', 'registry', 'shares', 'share', 'depositary', 'receipt', 'receipts',
  'common', 'stock', 'ordinary', 'adr', 'ads', 'plc.', 'and',
]);

const GENERIC_QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'about', 'into', 'from', 'their', 'this', 'that',
  'what', 'how', 'why', 'investment', 'investor', 'investors', 'relevant', 'episode',
  'episodes', 'discuss', 'discusses', 'should', 'business', 'company', 'market',
  'growth', 'revenue', 'strategy', 'outlook', 'guidance', // too common to discriminate
]);

interface Keywords {
  entityFull: string;     // cleaned, lowercased — e.g. "coca-cola"
  entityTokens: string[]; // discriminating tokens, lowercased — e.g. ["coca", "cola"]
  queryTokens: string[];  // content words from queries + feedTerms
  ticker?: string;        // lowercased ticker if present
}

// ── Name cleanup ──────────────────────────────────────────────────────────────

function cleanEntityName(name: string): string {
  // Drop parentheticals and ticker annotations: "Coca-Cola Company (The)" → "Coca-Cola Company"
  let s = name.replace(/\([^)]*\)/g, ' ').replace(/\bticker:\s*\w+/i, ' ');
  // Drop corporate suffixes token-by-token
  const kept = s.split(/\s+/).filter(Boolean).filter(tok => {
    const t = tok.toLowerCase().replace(/[.,]/g, '');
    return !CORP_STOPWORDS.has(t);
  });
  s = kept.join(' ').trim();
  return s || name.trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !CORP_STOPWORDS.has(t));
}

function buildKeywords(expansion: SearchExpansion): Keywords {
  const cleanName = cleanEntityName(expansion.entityName);
  const entityTokens = tokenize(cleanName);

  const tickerMatch = /ticker:\s*(\w+)/i.exec(expansion.entityName);
  const ticker = tickerMatch ? tickerMatch[1].toLowerCase() : undefined;

  const querySource = [...(expansion.queries ?? []), ...(expansion.feedTerms ?? [])].join(' ');
  const queryTokens = [...new Set(
    tokenize(querySource).filter(t => !GENERIC_QUERY_STOPWORDS.has(t) && !entityTokens.includes(t))
  )];

  return { entityFull: cleanName.toLowerCase(), entityTokens, queryTokens, ticker };
}

// ── Relevance scoring ───────────────────────────────────────────────────────────
// 0 = irrelevant, 1 = entity named in title. Used both to rank and to filter.

function relevanceScore(ep: PIEpisode, kw: Keywords): number {
  const title = (ep.title ?? '').toLowerCase();
  const text  = `${ep.title ?? ''} ${ep.description ?? ''} ${ep.feedTitle ?? ''}`.toLowerCase();

  let s = 0;
  if (kw.entityFull && title.includes(kw.entityFull)) s = Math.max(s, 1.0);
  if (kw.entityFull && text.includes(kw.entityFull))  s = Math.max(s, 0.75);

  for (const tok of kw.entityTokens) {
    if (new RegExp(`\\b${tok}\\b`).test(title)) s = Math.max(s, 0.8);
    else if (new RegExp(`\\b${tok}\\b`).test(text)) s = Math.max(s, 0.55);
  }
  if (kw.ticker && new RegExp(`\\b${kw.ticker}\\b`).test(title)) s = Math.max(s, 0.7);

  const qInTitle = kw.queryTokens.filter(t => title.includes(t)).length;
  const qInText  = kw.queryTokens.filter(t => text.includes(t)).length;
  if (qInTitle >= 1) s = Math.max(s, 0.5);
  if (qInTitle >= 2) s = Math.max(s, 0.6);
  if (qInText  >= 2) s = Math.max(s, 0.45);

  return s;
}

// ── iTunes channel ──────────────────────────────────────────────────────────────
// One iTunes episode search, enriched with Podcast Index feed/date data so we get the
// true RSS pubDate (iTunes releaseDate drifts to "today" on episode updates).

async function itunesSearchEnriched(searchQuery: string): Promise<PIEpisode[]> {
  const itunesEps = await searchItunesEpisodes(searchQuery, 20).catch(() => []);
  if (itunesEps.length === 0) return [];

  const uniqueCollectionIds = [...new Set(itunesEps.map(e => e.collectionId))];
  const piLookups = await Promise.allSettled(
    uniqueCollectionIds.map(async id => {
      const feed = await getPodcastByItunesId(id);
      if (!feed) return { collectionId: id, feed: null, piEps: [] as PIEpisode[] };
      const piEps = await getEpisodes(feed.id, 20).catch(() => []);
      return { collectionId: id, feed, piEps };
    })
  );

  const piEpByUrl = new Map<string, PIEpisode>();
  const feedByCollectionId = new Map<number, { feedId: number; feedUrl: string; feedTitle: string }>();
  for (const r of piLookups) {
    if (r.status !== 'fulfilled' || !r.value.feed) continue;
    const { collectionId, feed, piEps } = r.value;
    feedByCollectionId.set(collectionId, { feedId: feed.id, feedUrl: feed.feedUrl, feedTitle: feed.title });
    for (const ep of piEps) if (ep.enclosureUrl) piEpByUrl.set(ep.enclosureUrl, ep);
  }

  const seen = new Set<number>();
  const results: PIEpisode[] = [];
  for (const ep of itunesEps) {
    if (seen.has(ep.trackId)) continue;
    seen.add(ep.trackId);
    if (AI_FARM_RE.test(ep.collectionName ?? '')) continue;

    const feed = feedByCollectionId.get(ep.collectionId);
    const piEp = piEpByUrl.get(ep.episodeUrl);
    results.push({
      id:            ep.trackId,
      guid:          String(ep.trackId),
      feedId:        feed?.feedId ?? 0,
      feedTitle:     feed?.feedTitle ?? ep.collectionName,
      feedUrl:       feed?.feedUrl ?? '',
      title:         ep.trackName,
      description:   ep.description ?? '',
      datePublished: piEp?.datePublished ?? Math.floor(new Date(ep.releaseDate).getTime() / 1000),
      duration:      piEp?.duration      ?? Math.floor((ep.trackTimeMillis ?? 0) / 1000),
      enclosureUrl:  ep.episodeUrl,
      image:         ep.artworkUrl600 ?? '',
    });
  }
  return results;
}

async function multiItunesSearch(terms: string[]): Promise<PIEpisode[]> {
  const settled = await Promise.allSettled(terms.map(itunesSearchEnriched));
  const byId = new Map<number, PIEpisode>();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const ep of r.value) if (!byId.has(ep.id)) byId.set(ep.id, ep);
  }
  return [...byId.values()];
}

// ── Podcast Index feed channel (secondary) ──────────────────────────────────────

async function fetchByFeedTerms(feedTerms: string[], entityName: string): Promise<PIEpisode[]> {
  const searchTerms = feedTerms.length ? [entityName, ...feedTerms] : [entityName];
  const feedSearches = await Promise.allSettled(searchTerms.map(q => searchPodcasts(q)));

  const feedMap = new Map<number, { id: number }>();
  for (const r of feedSearches) {
    if (r.status !== 'fulfilled') continue;
    for (const f of r.value) if (!feedMap.has(f.id)) feedMap.set(f.id, f);
  }
  const feeds = [...feedMap.values()];
  if (feeds.length === 0) return [];

  const episodeFetches = await Promise.allSettled(feeds.slice(0, 15).map(f => getEpisodes(f.id, 3)));
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
  return merged;
}

// ── Orchestrator ────────────────────────────────────────────────────────────────

const MIN_RELEVANCE = 0.5; // entity/ticker named in title, or strong query overlap

export async function fetchSearchEpisodes(
  expansion: SearchExpansion,
  maxTotal = 20,
  sinceTimestamp?: number
): Promise<PIEpisode[]> {
  const kw = buildKeywords(expansion);
  const cleanName = cleanEntityName(expansion.entityName);

  // Build the primary entity-episode search terms.
  const entityTerms = [...new Set([
    cleanName,
    kw.ticker ? `${cleanName} ${kw.ticker}` : null,
    ...(expansion.queries ?? []).slice(0, 2),
  ].filter(Boolean) as string[])];

  const people = expansion.inputType === 'person' ? [] : (expansion.relatedPeople ?? []);

  const [entityEps, feedEps, ...peopleEps] = await Promise.all([
    multiItunesSearch(entityTerms),
    fetchByFeedTerms(expansion.feedTerms ?? [], cleanName),
    ...people.map(p => itunesSearchEnriched(`${p} ${cleanName}`)),
  ]);

  // Stable content-identity key: normalized title + publish-day.
  // Catches the same episode arriving with different iTunes trackId vs PI episode-id,
  // and iTunes re-issuing the same track under multiple trackIds in different feeds.
  function epKey(ep: PIEpisode): string {
    const t = (ep.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const day = ep.datePublished ? Math.floor(ep.datePublished / 86400) : 0;
    return `${t}::${day}`;
  }
  // Normalize enclosure URLs: strip query strings so iTunes redirect wrappers
  // that differ only in tracking params don't defeat URL dedup.
  function normalizeUrl(url: string): string {
    try { return new URL(url).origin + new URL(url).pathname; } catch { return url; }
  }

  // Merge all channels, dedup by episode id, normalized audio URL, and content-identity key.
  const byId = new Map<number, PIEpisode>();
  const seenUrls = new Set<string>();
  const seenKeys = new Set<string>();
  const add = (eps: PIEpisode[]) => {
    for (const ep of eps) {
      if (!ep.enclosureUrl) continue;
      const normUrl = normalizeUrl(ep.enclosureUrl);
      const key = epKey(ep);
      if (byId.has(ep.id) || seenUrls.has(normUrl) || seenKeys.has(key)) continue;
      byId.set(ep.id, ep);
      seenUrls.add(normUrl);
      seenKeys.add(key);
    }
  };
  add(entityEps);
  add(feedEps);
  for (const p of peopleEps) add(p);

  // Score relevance and filter. The same relevance gate makes the people channel
  // identity-safe: a person episode that never mentions the company scores < MIN_RELEVANCE.
  const scored = [...byId.values()]
    .map(ep => ({ ep, rel: relevanceScore(ep, kw) }))
    .filter(({ ep, rel }) => {
      if (rel < MIN_RELEVANCE) return false;
      if (sinceTimestamp && ep.datePublished < sinceTimestamp) return false;
      return true;
    });

  // Rank by relevance first, then recency. Investors want the most on-topic recent episodes.
  scored.sort((a, b) => (b.rel - a.rel) || (b.ep.datePublished - a.ep.datePublished));

  return scored.slice(0, maxTotal).map(s => s.ep);
}
