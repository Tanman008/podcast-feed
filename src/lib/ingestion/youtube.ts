// lib/ingestion/youtube.ts
// YouTube metadata fetching (title via oEmbed, thumbnail).
// Transcript fetching has moved to transcriber.ts (Deepgram audio pipeline).

import { withRetry } from '@/lib/utils/retry';

export interface YouTubeMetadata {
  videoId: string;
  title: string;
  description: string;
  publishedAt: Date;
  thumbnailUrl: string;
}

// Extract video ID from various YouTube URL formats
export function extractVideoId(videoUrl: string): string | null {
  try {
    const url = new URL(videoUrl);
    if (url.hostname.includes('youtube.com')) {
      return url.searchParams.get('v');
    }
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchVideoTitle(videoId: string): Promise<string> {
  try {
    const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`;
    const res = await fetch(oEmbedUrl);
    if (!res.ok) throw new Error(`oEmbed ${res.status}`);
    const data = await res.json() as { title?: string };
    return data.title || `Video ${videoId}`;
  } catch {
    return `Video ${videoId}`;
  }
}

// Fetches title and thumbnail only — duration is set from the Deepgram response.
export async function fetchYouTubeMetadata(videoId: string): Promise<YouTubeMetadata> {
  return withRetry(async () => {
    const title = await fetchVideoTitle(videoId);
    return {
      videoId,
      title,
      description: '',
      publishedAt: new Date(),
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    };
  });
}
