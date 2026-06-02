// POST /api/channels/[sourceId]/check — manually trigger a feed check (RSS or search)
import { NextRequest, NextResponse } from 'next/server';
import { SourceType } from '@prisma/client';
import { db } from '@/lib/db';
import { checkChannelForNewVideos } from '@/lib/worker/rssMonitor';
import { checkSearchForNewEpisodes } from '@/lib/worker/searchMonitor';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> }
) {
  const { sourceId } = await params;
  const body = await req.json().catch(() => ({}));
  const backfillCount: number | undefined = body.backfillCount;

  try {
    const source = await db.source.findUnique({
      where: { id: sourceId },
      select: { sourceType: true },
    });

    const enqueued = source?.sourceType === SourceType.search
      ? await checkSearchForNewEpisodes(sourceId)
      : await checkChannelForNewVideos(sourceId, { backfillCount });

    return NextResponse.json({ enqueued });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
