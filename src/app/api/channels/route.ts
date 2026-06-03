// GET  /api/channels — list all followed podcasts
// POST /api/channels — add a podcast by URL/name (with optional backfillCount)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { resolvePodcast } from '@/lib/podcast-index/resolver';
import { getPodcastById } from '@/lib/podcast-index/client';
import { checkPodcastForNewEpisodes } from '@/lib/worker/rssMonitor';

export async function GET() {
  try {
    const sources = await db.source.findMany({
      where: { following: true },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { episodes: true } } },
    });
    return NextResponse.json({
      channels: sources.map(s => ({
        id:                  s.id,
        name:                s.name,
        url:                 s.url,
        imageUrl:            s.imageUrl,
        episodeCount:        s._count.episodes,
        createdAt:           s.createdAt,
        minDurationSeconds:  s.minDurationSeconds,
        maxDurationSeconds:  s.maxDurationSeconds,
        checkIntervalHours:  s.checkIntervalHours,
        lastCheckedAt:       s.lastCheckedAt,
        searchQuery:         (s as any).searchQuery ?? null,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { url, backfillCount, minDurationSeconds, maxDurationSeconds } = await req.json();
    if (!url?.trim()) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    const info = await resolvePodcast(url.trim());
    if (!info) {
      return NextResponse.json(
        { error: 'Could not find podcast. Try a more specific name, an RSS feed URL, or a Podcast Index URL.' },
        { status: 400 }
      );
    }

    const existing = await db.source.findFirst({ where: { url: info.canonicalUrl } });

    let source;
    if (existing) {
      source = await db.source.update({
        where: { id: existing.id },
        data: {
          name:      info.name,
          url:       info.canonicalUrl,
          feedUrl:   info.feedUrl,
          following: true,
          ...(minDurationSeconds !== undefined && { minDurationSeconds: minDurationSeconds ?? null }),
          ...(maxDurationSeconds !== undefined && { maxDurationSeconds: maxDurationSeconds ?? null }),
        },
      });
    } else {
      const feed = info.feedId ? await getPodcastById(info.feedId).catch(() => null) : null;
      const baseSlug = info.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      let slug = baseSlug;
      let attempt = 0;
      while (await db.source.findUnique({ where: { slug } })) {
        slug = `${baseSlug}-${++attempt}`;
      }
      source = await db.source.create({
        data: {
          name:               info.name,
          slug,
          sourceType:         'podcast',
          platform:           'podcast_index',
          url:                info.canonicalUrl,
          feedUrl:            info.feedUrl,
          imageUrl:           feed?.image ?? info.imageUrl ?? null,
          minDurationSeconds: minDurationSeconds ?? null,
          maxDurationSeconds: maxDurationSeconds ?? null,
        },
      });
    }

    // Kick off backfill in background (non-blocking)
    if (backfillCount && backfillCount > 0) {
      checkPodcastForNewEpisodes(source.id, { backfillCount }).catch(e =>
        console.error('[Channels] Backfill failed:', e)
      );
    }

    return NextResponse.json({ channel: source, created: !existing }, { status: existing ? 200 : 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
