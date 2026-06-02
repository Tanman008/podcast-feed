// Resolves a user-supplied string into a Podcast Index feed.
// Accepts: RSS feed URL, Podcast Index URL (podcastindex.org/podcast/<id>), or free-text name.

import { getPodcastByUrl, getPodcastById, searchPodcasts } from './client';
import type { PIFeed } from './types';

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

  // Podcast Index web URL → look up by feed ID
  const piId = extractPodcastIndexId(trimmed);
  if (piId) {
    const feed = await getPodcastById(piId);
    return feed ? feedToInfo(feed) : null;
  }

  // Looks like an RSS/HTTP URL → look up by feed URL
  if (looksLikeFeedUrl(trimmed)) {
    const feed = await getPodcastByUrl(trimmed);
    return feed ? feedToInfo(feed) : null;
  }

  // Free-text → search and return best match
  const results = await searchPodcasts(trimmed);
  return results.length > 0 ? feedToInfo(results[0]) : null;
}
