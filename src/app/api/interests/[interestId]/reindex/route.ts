// POST /api/interests/[interestId]/reindex
// Deletes all stored matches for this interest and re-runs the backfill synchronously.
// Matching is now pure DB reads (no LLM calls) so this completes in seconds.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { backfillInterest } from '@/lib/matching/engine';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ interestId: string }> }
) {
  try {
    const { interestId } = await params;

    const interest = await db.userInterest.findUnique({ where: { id: interestId } });
    if (!interest) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await db.interestMatch.deleteMany({ where: { interestId } });

    const written = await backfillInterest(interest.id, interest.term);
    return NextResponse.json({ ok: true, written, term: interest.term });
  } catch (err: any) {
    console.error('[Reindex] failed:', err);
    return NextResponse.json({ error: err?.message ?? 'Backfill failed' }, { status: 500 });
  }
}
