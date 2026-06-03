// Resolves a user-supplied string into a Podcast Index feed.
// Accepts: RSS feed URL, Podcast Index URL (podcastindex.org/podcast/<id>), or free-text name.

import { getPodcastByUrl, getPodcastById, searchPodcasts } from './client';
import { fetchRSSFeedMeta } from '@/lib/ingestion/rssParser';
import type { PIFeed } from './types';

function piKeysConfigured(): boolean {
  const key    = process.env.PODCAST_INDEX_API_KEY;
  const secret = process.env.PODCAST_INDEX_API_SECRET_B64 ?? process.env.PODCAST_INDEX_API_SECRET;
  return !!(key && secret);
}

export interface PodcastInfo {
  feedId:       number;
  feedUrl:      string;
  name:         string;
  imageUrl:     string;
  canonicalUrl: string; // e.g. https://podcastindex.org/podcast/920666
}

function feedToInfo(feed: PIFeed): PodcastInfo {
  return {
    feedId:       feed.id,
    feedUrl:      feed.feedUrl,
    name:         feed.title,
    imageUrl:     feed.image,
    canonicalUrl: feed.url,
  };
}

// podcastindex.org/podcast/<id>  or  podcastindex.org/podcast/<id>/episode/<epId>
function extractPodcastIndexId(url: string): number | null {
  const m = url.match(/podcastindex\.org\/podcast\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function looksLikeFeedUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function resolvePodcast(input: string): Promise<PodcastInfo | null> {
  const trimmed = input.trim();

  // Podcast Index web URL → look up by feed ID (requires PI keys)
  const piId = extractPodcastIndexId(trimmed);
  if (piId) {
    if (!piKeysConfigured()) throw new Error(
      'Podcast Index API keys are not configured. Add PODCAST_INDEX_API_KEY and PODCAST_INDEX_API_SECRET to .env.local to follow channels by name or Podcast Index URL.'
    );
    const feed = await getPodcastById(piId);
    return feed ? feedToInfo(feed) : null;
  }

  // Looks like an RSS/HTTP URL → try PI first; fall back to direct RSS parse if keys absent
  if (looksLikeFeedUrl(trimmed)) {
    if (piKeysConfigured()) {
      const feed = await getPodcastByUrl(trimmed).catch(() => null);
      if (feed) return feedToInfo(feed);
    }
    // Keyless fallback: fetch and parse the RSS feed directly
    const meta = await fetchRSSFeedMeta(trimmed);
    return {
      feedId:       0,
      feedUrl:      trimmed,
      name:         meta.title,
      imageUrl:     meta.imageUrl ?? '',
      canonicalUrl: trimmed,   // use the RSS URL itself as the canonical key
    };
  }

  // Free-text → search via PI (requires keys)
  if (!piKeysConfigured()) throw new Error(
    'Podcast Index API keys are not configured. Paste an RSS feed URL to follow without keys, or add PODCAST_INDEX_API_KEY and PODCAST_INDEX_API_SECRET to .env.local.'
  );

  const results = await searchPodcasts(trimmed);
  if (!results.length) return null;

  const q = trimmed.toLowerCase();

  // 1. Exact title match
  const exact = results.find(f => f.title.toLowerCase() === q);
  if (exact) return feedToInfo(exact);

  // 2. Title starts with query (e.g. "all-in" → "All-In Podcast")
  const startsWith = results.find(f => f.title.toLowerCase().startsWith(q));
  if (startsWith) return feedToInfo(startsWith);

  // 3. First result
  return feedToInfo(results[0]);
}
