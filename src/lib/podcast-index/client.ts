import crypto from 'crypto';
import type { PIFeed, PIEpisode } from './types';

const BASE = 'https://api.podcastindex.org/api/1.0';

function authHeaders(): Record<string, string> {
  const key = process.env.PODCAST_INDEX_API_KEY;
  // Secret may contain $ signs which dotenv mangles — store as base64 to avoid this
  const secretB64 = process.env.PODCAST_INDEX_API_SECRET_B64;
  const secret = secretB64
    ? Buffer.from(secretB64, 'base64').toString('utf8')
    : process.env.PODCAST_INDEX_API_SECRET;
  if (!key || !secret) throw new Error('Missing PODCAST_INDEX_API_KEY or PODCAST_INDEX_API_SECRET(_B64)');

  // Must be integer seconds — float causes hash mismatch on the server
  const epoch = Math.floor(Date.now() / 1000).toString();
  const hash  = crypto.createHash('sha1').update(key + secret + epoch).digest('hex');

  return {
    'X-Auth-Key':  key,
    'X-Auth-Date': epoch,
    Authorization: hash,
    'User-Agent':  'PodcastFeedApp/1.0',
  };
}

async function piGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${BASE}/${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Podcast Index API ${res.status}: ${text}`);
  }
  return res.json();
}

export async function searchPodcasts(term: string): Promise<PIFeed[]> {
  const data = await piGet('search/byterm', { q: term, max: 20 });
  return (data?.feeds ?? []).map(normalizeFeed);
}

export async function getPodcastByUrl(feedUrl: string): Promise<PIFeed | null> {
  const data = await piGet('podcasts/byfeedurl', { url: feedUrl });
  return data?.feed ? normalizeFeed(data.feed) : null;
}

export async function getPodcastById(feedId: number): Promise<PIFeed | null> {
  const data = await piGet('podcasts/byfeedid', { id: feedId });
  return data?.feed ? normalizeFeed(data.feed) : null;
}

export async function getEpisodes(feedId: number, max = 10): Promise<PIEpisode[]> {
  const data = await piGet('episodes/byfeedid', { id: feedId, max });
  return (data?.items ?? []).map(normalizeEpisode);
}

export async function getEpisodeById(episodeId: number): Promise<PIEpisode | null> {
  const data = await piGet('episodes/byid', { id: episodeId });
  return data?.episode ? normalizeEpisode(data.episode) : null;
}

export async function searchEpisodesByPerson(name: string): Promise<PIEpisode[]> {
  const data = await piGet('search/byperson', { q: name });
  return (data?.items ?? []).map(normalizeEpisode);
}

export async function getPodcastByItunesId(itunesId: number): Promise<PIFeed | null> {
  const data = await piGet('podcasts/byitunesid', { id: itunesId });
  return data?.feed ? normalizeFeed(data.feed) : null;
}

export async function searchItunesEpisodes(term: string, limit = 10): Promise<ItunesEpisode[]> {
  const qs  = new URLSearchParams({ term, media: 'podcast', entity: 'podcastEpisode', limit: String(limit) }).toString();
  const res = await fetch(`https://itunes.apple.com/search?${qs}`, {
    headers: { 'User-Agent': 'PodcastFeedApp/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`iTunes API ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).filter((r: any) => r.kind === 'podcast-episode' && r.episodeUrl);
}

export interface ItunesEpisode {
  trackId:         number;
  collectionId:    number;
  collectionName:  string;
  trackName:       string;
  episodeUrl:      string;
  releaseDate:     string;
  trackTimeMillis: number;
  artworkUrl600?:  string;
  description?:    string;
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
