// GET  /api/interests          — list all interest terms
// POST /api/interests          — create a new interest term + trigger backfill

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { backfillInterest } from '@/lib/matching/engine';

export async function GET() {
  try {
    const interests = await db.userInterest.findMany({
      where: { userId: 'default' },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { matches: true } } },
    });
    return NextResponse.json({ interests });
  } catch (error: any) {
    console.error('[API] GET /interests error:', error);
    return NextResponse.json({ error: error.message ?? 'Failed to load interests' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { term } = body;
    if (!term || typeof term !== 'string' || !term.trim()) {
      return NextResponse.json({ error: 'term is required' }, { status: 400 });
    }

    const interest = await db.userInterest.create({
      data: { term: term.trim() },
    });

    // Backfill runs async — response returns immediately, backfill runs in background
    backfillInterest(interest.id, interest.term).catch(err =>
      console.error(`[Backfill] Interest ${interest.id} failed:`, err)
    );

    return NextResponse.json({ interest, backfilling: true }, { status: 201 });
  } catch (error: any) {
    console.error('[API] POST /interests error:', error);
    return NextResponse.json({ error: error.message ?? 'Failed to create interest' }, { status: 500 });
  }
}
