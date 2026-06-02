// src/app/api/ingest/youtube/route.ts
// POST /api/ingest/youtube — enqueue ingestion job
// Auto-creates Source from YouTube channel metadata (oEmbed). No sourceId required.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { extractVideoId } from '@/lib/ingestion/youtube';

interface OEmbedResponse {
  title: string;
  author_name: string;
  author_url: string;
}

async function fetchOEmbed(videoId: string): Promise<OEmbedResponse | null> {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json() as Promise<OEmbedResponse>;
  } catch {
    return null;
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Find or create a Source row from the YouTube channel name + URL
async function upsertSourceFromChannel(
  channelName: string,
  channelUrl: string
): Promise<string> {
  const baseSlug = slugify(channelName);

  // Try to find existing source by slug or channel URL
  const existing = await db.source.findFirst({
    where: { OR: [{ slug: baseSlug }, { url: channelUrl }] },
    select: { id: true },
  });
  if (existing) return existing.id;

  // Create new source — handle rare slug collision by appending random suffix
  let slug = baseSlug;
  let attempts = 0;
  while (attempts < 5) {
    try {
      const source = await db.source.create({
        data: {
          name: channelName,
          slug,
          sourceType: 'youtube',
          platform: 'youtube',
          url: channelUrl,
        },
      });
      return source.id;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
        attempts++;
      } else {
        throw e;
      }
    }
  }
  throw new Error(`Could not create source for channel: ${channelName}`);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { videoUrl } = body;

    if (!videoUrl || typeof videoUrl !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: videoUrl' },
        { status: 400 }
      );
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return NextResponse.json({ error: 'Invalid YouTube URL' }, { status: 400 });
    }

    // Fetch channel metadata from oEmbed
    const oembed = await fetchOEmbed(videoId);
    if (!oembed) {
      return NextResponse.json(
        { error: 'Could not fetch video metadata — check the URL and ensure the video is public' },
        { status: 400 }
      );
    }

    // Auto-create or find the source from the channel name
    const sourceId = await upsertSourceFromChannel(oembed.author_name, oembed.author_url);

    // Enqueue ingestion job
    const job = await db.ingestionJob.create({
      data: { videoUrl, sourceId, status: 'queued' },
    });

    console.log(`[API] Enqueued job ${job.id} — "${oembed.title}" by ${oembed.author_name}`);

    return NextResponse.json(
      {
        jobId: job.id,
        status: 'queued',
        videoTitle: oembed.title,
        channelName: oembed.author_name,
        message: 'Job enqueued. Poll /api/ingest/jobs/{jobId} for progress.',
      },
      { status: 202 }
    );
  } catch (error: any) {
    console.error('[API] Ingestion error:', error);
    return NextResponse.json({ error: 'Failed to create ingestion job' }, { status: 500 });
  }
}
