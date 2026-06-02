// PATCH /api/channels/[sourceId]/settings — update per-channel ingestion settings

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> }
) {
  const { sourceId } = await params;
  const body = await req.json();

  const data: Record<string, unknown> = {};
  if ('minDurationSeconds' in body) data.minDurationSeconds = body.minDurationSeconds ?? null;
  if ('maxDurationSeconds' in body) data.maxDurationSeconds = body.maxDurationSeconds ?? null;
  if ('checkIntervalHours' in body) data.checkIntervalHours = Number(body.checkIntervalHours);

  try {
    const source = await db.source.update({ where: { id: sourceId }, data });
    return NextResponse.json({ ok: true, source });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
