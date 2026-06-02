// GET  /api/channels — list all monitored channels
// POST /api/channels — add a channel by URL (with optional backfillDays)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { resolveChannel } from '@/lib/youtube/channels';
import { checkChannelForNewVideos } from '@/lib/worker/rssMonitor';

export async function GET() {
  try {
    const sources = await db.source.findMany({
      where: { platform: 'youtube', following: true },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { episodes: true } } },
    });
    const monitorable = sources.filter(s => /youtube\.com\/channel\/UC[\w-]+/.test(s.url));
    return NextResponse.json({
      channels: monitorable.map(s => ({
        id: s.id,
        name: s.name,
        url: s.url,
        episodeCount: s._count.episodes,
        createdAt: s.createdAt,
        minDurationSeconds: s.minDurationSeconds,
        maxDurationSeconds: s.maxDurationSeconds,
        checkIntervalHours: s.checkIntervalHours,
        lastCheckedAt: s.lastCheckedAt,
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

    const info = await resolveChannel(url.trim());
    if (!info) {
      return NextResponse.json(
        { error: 'Could not resolve channel ID. Try the direct channel URL (youtube.com/channel/UC...).' },
        { status: 400 }
      );
    }

    const existing = await db.source.findFirst({ where: { url: info.canonicalUrl } });

    let source;
    if (existing) {
      source = await db.source.update({
        where: { id: existing.id },
        data: {
          name: info.name,
          url: info.canonicalUrl,
          following: true,
          ...(minDurationSeconds !== undefined && { minDurationSeconds: minDurationSeconds ?? null }),
          ...(maxDurationSeconds !== undefined && { maxDurationSeconds: maxDurationSeconds ?? null }),
        },
      });
    } else {
      const baseSlug = info.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      let slug = baseSlug;
      let attempt = 0;
      while (await db.source.findUnique({ where: { slug } })) {
        slug = `${baseSlug}-${++attempt}`;
      }
      source = await db.source.create({
        data: {
          name: info.name,
          slug,
          sourceType: 'youtube',
          platform: 'youtube',
          url: info.canonicalUrl,
          minDurationSeconds: minDurationSeconds ?? null,
          maxDurationSeconds: maxDurationSeconds ?? null,
        },
      });
    }

    // Kick off backfill in background (non-blocking)
    if (backfillCount && backfillCount > 0) {
      checkChannelForNewVideos(source.id, { backfillCount }).catch(e =>
        console.error('[Channels] Backfill failed:', e)
      );
    }

    return NextResponse.json({ channel: source, created: !existing }, { status: existing ? 200 : 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
