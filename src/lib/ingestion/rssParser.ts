// lib/ingestion/rssParser.ts
// Parses podcast RSS feeds to extract episode metadata.
// Only reads the fields we care about — no full XML DOM needed.

import { XMLParser } from 'fast-xml-parser';

export interface RSSEpisode {
  guid:         string;
  title:        string;
  audioUrl:     string;
  publishedAt:  Date | null;
  durationSecs: number | null;
}

const parser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  // Treat these as arrays even when there's only one item
  isArray: (name) => name === 'item',
});

function parseDuration(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return raw > 0 ? raw : null;

  const s = String(raw).trim();
  // HH:MM:SS or MM:SS
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function extractGuid(item: any): string {
  const g = item.guid;
  if (!g) return '';
  if (typeof g === 'string') return g.trim();
  if (typeof g === 'object') return (g['#text'] ?? g['@_text'] ?? '').toString().trim();
  return String(g).trim();
}

export interface RSSFeedMeta {
  title:    string;
  imageUrl: string | null;
  feedUrl:  string;
}

export async function fetchRSSFeedMeta(feedUrl: string): Promise<RSSFeedMeta> {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'PodcastFeedApp/1.0 (RSS Monitor)' },
  });
  if (!res.ok) throw new Error(`RSS fetch failed: HTTP ${res.status} for ${feedUrl}`);

  const xml  = await res.text();
  const data = parser.parse(xml);
  const channel = data?.rss?.channel ?? {};

  const title    = (channel.title ?? '').toString().trim() || 'Untitled Podcast';
  const imageUrl =
    channel['itunes:image']?.['@_href'] ??
    channel['itunes:image'] ??
    channel.image?.url ??
    null;

  return { title, imageUrl: typeof imageUrl === 'string' ? imageUrl : null, feedUrl };
}

export async function fetchRSSEpisodes(feedUrl: string): Promise<RSSEpisode[]> {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'PodcastFeedApp/1.0 (RSS Monitor)' },
  });
  if (!res.ok) throw new Error(`RSS fetch failed: HTTP ${res.status} for ${feedUrl}`);

  const xml  = await res.text();
  const data = parser.parse(xml);

  const items: any[] = data?.rss?.channel?.item ?? [];

  const episodes: RSSEpisode[] = [];
  for (const item of items) {
    const guid     = extractGuid(item);
    const title    = (item.title ?? '').toString().trim();
    const enclosure = item.enclosure;
    const audioUrl  = enclosure?.['@_url'] ?? '';

    if (!guid || !audioUrl) continue;

    const pubRaw     = item.pubDate ?? item['dc:date'] ?? null;
    const publishedAt = pubRaw ? new Date(pubRaw) : null;

    const durationRaw = item['itunes:duration'] ?? item.duration ?? null;
    const durationSecs = parseDuration(durationRaw);

    episodes.push({ guid, title, audioUrl, publishedAt: publishedAt?.toString() === 'Invalid Date' ? null : publishedAt, durationSecs });
  }

  return episodes;
}
