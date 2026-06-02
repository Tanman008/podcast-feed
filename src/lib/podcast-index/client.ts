import podcastIndexApi from 'podcast-index-api';
import type { PIFeed, PIEpisode } from './types';

function getClient() {
  const key    = process.env.PODCAST_INDEX_API_KEY;
  const secret = process.env.PODCAST_INDEX_API_SECRET;
  if (!key || !secret) throw new Error('Missing PODCAST_INDEX_API_KEY or PODCAST_INDEX_API_SECRET');
  return podcastIndexApi(key, secret, 'PodcastFeedApp/1.0');
}

export async function searchPodcasts(term: string): Promise<PIFeed[]> {
  const res = await getClient().searchByTerm(term);
  return (res?.feeds ?? []).map(normalizeFeed);
}

export async function getPodcastByUrl(feedUrl: string): Promise<PIFeed | null> {
  const res = await getClient().podcastsByFeedUrl(feedUrl);
  return res?.feed ? normalizeFeed(res.feed) : null;
}

export async function getPodcastById(feedId: number): Promise<PIFeed | null> {
  const res = await getClient().podcastsByFeedId(feedId);
  return res?.feed ? normalizeFeed(res.feed) : null;
}

export async function getEpisodes(feedId: number, max = 10): Promise<PIEpisode[]> {
  const res = await getClient().episodesByFeedId(feedId, null, max);
  return (res?.items ?? []).map(normalizeEpisode);
}

export async function getEpisodeById(episodeId: number): Promise<PIEpisode | null> {
  const res = await getClient().episodesById(episodeId);
  return res?.episode ? normalizeEpisode(res.episode) : null;
}

function normalizeFeed(f: any): PIFeed {
  return {
    id:          f.id,
    feedUrl:     f.url ?? f.feedUrl ?? '',
    title:       f.title ?? '',
    image:       f.image ?? f.artwork ?? '',
    description: f.description ?? '',
    author:      f.author ?? f.ownerName ?? '',
    url:         `https://podcastindex.org/podcast/${f.id}`,
  };
}

function normalizeEpisode(e: any): PIEpisode {
  return {
    id:            e.id,
    guid:          e.guid ?? String(e.id),
    feedId:        e.feedId,
    feedTitle:     e.feedTitle ?? '',
    feedUrl:       e.feedUrl ?? '',
    title:         e.title ?? '',
    description:   e.description ?? '',
    datePublished: e.datePublished ?? 0,
    duration:      e.duration ?? 0,
    enclosureUrl:  e.enclosureUrl ?? '',
    image:         e.image ?? e.feedImage ?? '',
  };
}
