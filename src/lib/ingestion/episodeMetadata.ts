// lib/ingestion/episodeMetadata.ts
// Resolves a podcast episode URL into metadata needed to start ingestion.
// Replaces youtube.ts — no YouTube dependencies.

import { getEpisodeById, getPodcastByUrl, getEpisodes } from '@/lib/podcast-index/client';
import { resolvePodcast } from '@/lib/podcast-index/resolver';

export interface EpisodeMetadata {
  externalId:      string; // Podcast Index episode ID (as string)
  title:           string;
  description:     string;
  publishedAt:     Date | null;
  thumbnailUrl:    string | null;
  durationSeconds: number | null;
  audioUrl:        string;
  feedId:          number;
  feedTitle:       string;
  feedUrl:         string;
}

// Extract Podcast Index episode ID from a podcastindex.org/podcast/<feedId>/episode/<epId> URL.
// Returns null for RSS URLs or other formats.
export function extractEpisodeIdFromUrl(url: string): number | null {
  const m = url.match(/podcastindex\.org\/podcast\/\d+\/episode\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Extract feedId from a podcastindex.org/podcast/<feedId> URL.
function extractFeedIdFromUrl(url: string): number | null {
  const m = url.match(/podcastindex\.org\/podcast\/(\d+)(?:\/|$)/);
  return m ? parseInt(m[1], 10) : null;
}

function looksLikeAudioUrl(url: string): boolean {
  return /\.(mp3|m4a|ogg|opus|aac|wav|flac)(\?|$)/i.test(url);
}

// Primary entry point: resolve any podcast episode URL to full metadata.
// Accepts:
//   - https://podcastindex.org/podcast/<feedId>/episode/<episodeId>
//   - https://podcastindex.org/podcast/<feedId>   (uses most recent episode)
//   - Any RSS feed URL                            (uses most recent episode)
//   - A direct audio file URL (mp3/m4a/etc.)      (minimal metadata, no PI lookup)
export async function fetchEpisodeMetadata(episodeUrl: string): Promise<EpisodeMetadata> {
  // Direct audio URL — no PI lookup possible
  if (looksLikeAudioUrl(episodeUrl)) {
    return {
      externalId:      episodeUrl,
      title:           'Untitled Episode',
      description:     '',
      publishedAt:     null,
      thumbnailUrl:    null,
      durationSeconds: null,
      audioUrl:        episodeUrl,
      feedId:          0,
      feedTitle:       'Unknown Podcast',
      feedUrl:         '',
    };
  }

  // Podcast Index episode URL
  const episodeId = extractEpisodeIdFromUrl(episodeUrl);
  if (episodeId) {
    const ep = await getEpisodeById(episodeId);
    if (!ep) throw new Error(`Podcast Index episode not found: ${episodeId}`);
    if (!ep.enclosureUrl) throw new Error(`Episode has no audio URL: ${ep.title}`);
    return {
      externalId:      String(ep.id),
      title:           ep.title,
      description:     ep.description,
      publishedAt:     ep.datePublished ? new Date(ep.datePublished * 1000) : null,
      thumbnailUrl:    ep.image || null,
      durationSeconds: ep.duration || null,
      audioUrl:        ep.enclosureUrl,
      feedId:          ep.feedId,
      feedTitle:       ep.feedTitle,
      feedUrl:         ep.feedUrl,
    };
  }

  // Podcast Index feed URL — ingest most recent episode
  const feedId = extractFeedIdFromUrl(episodeUrl);
  if (feedId) {
    const episodes = await getEpisodes(feedId, 1);
    if (!episodes.length) throw new Error(`No episodes found for feed ${feedId}`);
    const ep = episodes[0];
    if (!ep.enclosureUrl) throw new Error(`Latest episode has no audio URL: ${ep.title}`);
    return {
      externalId:      String(ep.id),
      title:           ep.title,
      description:     ep.description,
      publishedAt:     ep.datePublished ? new Date(ep.datePublished * 1000) : null,
      thumbnailUrl:    ep.image || null,
      durationSeconds: ep.duration || null,
      audioUrl:        ep.enclosureUrl,
      feedId:          ep.feedId,
      feedTitle:       ep.feedTitle,
      feedUrl:         ep.feedUrl,
    };
  }

  // RSS feed URL — resolve via Podcast Index then get most recent episode
  const podcast = await resolvePodcast(episodeUrl);
  if (!podcast) throw new Error(`Could not resolve podcast from URL: ${episodeUrl}`);

  const episodes = await getEpisodes(podcast.feedId, 1);
  if (!episodes.length) throw new Error(`No episodes found for podcast: ${podcast.name}`);
  const ep = episodes[0];
  if (!ep.enclosureUrl) throw new Error(`Latest episode has no audio URL: ${ep.title}`);
  return {
    externalId:      String(ep.id),
    title:           ep.title,
    description:     ep.description,
    publishedAt:     ep.datePublished ? new Date(ep.datePublished * 1000) : null,
    thumbnailUrl:    ep.image || null,
    durationSeconds: ep.duration || null,
    audioUrl:        ep.enclosureUrl,
    feedId:          ep.feedId,
    feedTitle:       ep.feedTitle,
    feedUrl:         ep.feedUrl,
  };
}
