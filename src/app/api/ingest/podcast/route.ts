// POST /api/ingest/podcast — enqueue a podcast episode ingestion job
// Accepts a Podcast Index episode URL, RSS feed URL, or direct audio URL.
// Auto-creates the Source from Podcast Index feed metadata.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { fetchEpisodeMetadata } from '@/lib/ingestion/episodeMetadata';
import { resolvePodcast } from '@/lib/podcast-index/resolver';
import { getPodcastById } from '@/lib/podcast-index/client';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function upsertSourceFromFeed(feedId: number, feedTitle: string, feedUrl: string): Promise<string> {
  const canonicalUrl = `https://podcastindex.org/podcast/${feedId}`;
  const existing = await db.source.findFirst({
    where: { OR: [{ url: canonicalUrl }, { url: feedUrl }] },
    select: { id: true },
  });
  if (existing) return existing.id;

  const baseSlug = slugify(feedTitle || `podcast-${feedId}`);
  let slug = baseSlug;
  let attempts = 0;
  while (attempts < 5) {
    try {
      const source = await db.source.create({
        data: {
          name:       feedTitle,
          slug,
          sourceType: 'podcast',
          platform:   'podcast_index',
          url:        canonicalUrl,
          feedUrl:    feedUrl || null,
          imageUrl:   feedId ? (await getPodcastById(feedId))?.image ?? null : null,
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
  throw new Error(`Could not create source for podcast: ${feedTitle}`);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { episodeUrl } = body;

    if (!episodeUrl || typeof episodeUrl !== 'string') {
      return NextResponse.json({ error: 'Missing required field: episodeUrl' }, { status: 400 });
    }

    let metadata: Awaited<ReturnType<typeof fetchEpisodeMetadata>>;
    try {
      metadata = await fetchEpisodeMetadata(episodeUrl.trim());
    } catch (err: any) {
      return NextResponse.json(
        { error: `Could not resolve episode: ${err.message}` },
        { status: 400 }
      );
    }

    if (!metadata.audioUrl) {
      return NextResponse.json({ error: 'Episode has no audio URL' }, { status: 400 });
    }

    // Resolve source — create if needed
    let sourceId: string;
    if (metadata.feedId) {
      sourceId = await upsertSourceFromFeed(metadata.feedId, metadata.feedTitle, metadata.feedUrl);
    } else {
      // Direct audio URL with no feed info — create a minimal source
      const podcast = await resolvePodcast(episodeUrl.trim()).catch(() => null);
      if (podcast) {
        sourceId = await upsertSourceFromFeed(podcast.feedId, podcast.name, podcast.feedUrl);
      } else {
        sourceId = await upsertSourceFromFeed(0, 'Unknown Podcast', episodeUrl);
      }
    }

    const job = await db.ingestionJob.create({
      data: { episodeUrl: episodeUrl.trim(), sourceId, status: 'queued' },
    });

    console.log(`[API] Enqueued job ${job.id} — "${metadata.title}"`);

    return NextResponse.json(
      {
        jobId:       job.id,
        status:      'queued',
        episodeTitle: metadata.title,
        podcastName: metadata.feedTitle,
        message:     'Job enqueued. Poll /api/ingest/jobs/{jobId} for progress.',
      },
      { status: 202 }
    );
  } catch (error: any) {
    console.error('[API] Ingestion error:', error);
    return NextResponse.json({ error: 'Failed to create ingestion job' }, { status: 500 });
  }
}
