// lib/ingestion/youtube.ts
// Fetches YouTube metadata and transcripts
// Uses youtube-transcript npm package (handles captions automatically)

import { YoutubeTranscript } from 'youtube-transcript';
import { withRetry } from '@/lib/utils/retry';

export interface YouTubeMetadata {
  videoId: string;
  title: string;
  description: string;
  publishedAt: Date;
  durationSeconds: number;
  thumbnailUrl: string;
}

export interface TranscriptSegment {
  text: string;
  offset: number; // milliseconds
  duration: number; // milliseconds
}

// Extract video ID from various YouTube URL formats
export function extractVideoId(videoUrl: string): string | null {
  try {
    const url = new URL(videoUrl);

    // Format: youtube.com/watch?v=ID
    if (url.hostname.includes('youtube.com')) {
      return url.searchParams.get('v');
    }

    // Format: youtu.be/ID
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.slice(1);
    }

    return null;
  } catch {
    return null;
  }
}

// Fetch YouTube metadata (title, description, publish date, duration)
// This requires no API key when using youtube-transcript
// Metadata is extracted from the video page
export async function fetchYouTubeMetadata(videoId: string): Promise<YouTubeMetadata> {
  // Note: youtube-transcript doesn't provide metadata directly
  // We'll extract title from transcript first call or use placeholder
  // In a real scenario, you'd use YouTube Data API v3, but that requires OAuth

  return withRetry(async () => {
    // For Phase 1, we'll use basic metadata
    // The title/description come from the Episode upsert in the worker
    // This function mainly validates the videoId is accessible
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);

    if (!transcript || transcript.length === 0) {
      throw new Error(`No transcript found for video ${videoId}`);
    }

    return {
      videoId,
      title: `Video ${videoId}`, // Placeholder - will be overridden
      description: '',
      publishedAt: new Date(),
      durationSeconds: Math.ceil(
        (transcript[transcript.length - 1].offset + transcript[transcript.length - 1].duration) / 1000
      ),
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    };
  });
}

// Fetch transcript from YouTube
// Returns array of caption segments with timestamps
export async function fetchTranscript(videoId: string): Promise<TranscriptSegment[]> {
  return withRetry(async () => {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);

    if (!transcript || transcript.length === 0) {
      throw new Error(`Transcript unavailable for video: ${videoId}`);
    }

    return transcript.map(item => ({
      text: item.text,
      offset: item.offset,
      duration: item.duration,
    }));
  });
}
