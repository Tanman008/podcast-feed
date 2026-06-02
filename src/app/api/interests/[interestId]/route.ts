// DELETE /api/interests/[interestId] — remove interest + all its matches (cascade)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ interestId: string }> }
) {
  const { interestId } = await params;
  try {
    await db.userInterest.delete({ where: { id: interestId } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
