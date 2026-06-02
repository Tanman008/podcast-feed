// POST /api/channels/[sourceId]/check — manually trigger a feed check
import { NextRequest, NextResponse } from 'next/server';
import { checkChannelForNewVideos } from '@/lib/worker/rssMonitor';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> }
) {
  const { sourceId } = await params;
  const body = await req.json().catch(() => ({}));
  const backfillCount: number | undefined = body.backfillCount;

  try {
    const enqueued = await checkChannelForNewVideos(sourceId, { backfillCount });
    return NextResponse.json({ enqueued });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
