// DELETE /api/channels/[sourceId] — remove a channel (keeps episodes)
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> }
) {
  const { sourceId } = await params;
  try {
    // Cancel any pending jobs, then mark as unfollowed (keeps episodes + chunks intact)
    await db.ingestionJob.updateMany({
      where: { sourceId, status: { in: ['queued', 'running'] } },
      data: { status: 'failed', errorMessage: 'Channel unfollowed' },
    });
    await db.source.update({ where: { id: sourceId }, data: { following: false } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
