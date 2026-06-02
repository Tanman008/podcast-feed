// GET /api/channels/[sourceId]/jobs — aggregate job status for a channel (last 24h)
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> }
) {
  try {
    const { sourceId } = await params;
    const sinceParam = req.nextUrl.searchParams.get('since');
    const since = sinceParam
      ? new Date(parseInt(sinceParam))
      : new Date(Date.now() - 2 * 60 * 60 * 1000); // default: last 2h (initial-load case)

    const jobs = await db.ingestionJob.findMany({
      where: { sourceId, createdAt: { gte: since } },
      select: { status: true, progress: true },
    });

    const queued     = jobs.filter(j => j.status === 'queued').length;
    const running    = jobs.filter(j => j.status === 'running').length;
    const completed  = jobs.filter(j => j.status === 'completed').length;
    const failed     = jobs.filter(j => j.status === 'failed').length;
    const total      = jobs.length;

    // Each job contributes its fractional progress toward the total
    const done = jobs.reduce((sum, j) => {
      if (j.status === 'completed' || j.status === 'failed') return sum + 1;
      if (j.status === 'running') return sum + (j.progress ?? 0) / 100;
      return sum;
    }, 0);
    const overallProgress = total > 0 ? (done / total) * 100 : 0;

    return NextResponse.json({ queued, running, completed, failed, total, active: queued + running > 0, overallProgress });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
