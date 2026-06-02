import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> }
) {
  try {
    const { sourceId } = await params;
    const result = await db.ingestionJob.updateMany({
      where: { sourceId, status: { in: ['queued', 'running'] } },
      data: { status: 'failed', errorMessage: 'Cancelled by user' },
    });
    return NextResponse.json({ cancelled: result.count });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
