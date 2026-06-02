// DELETE /api/episodes/clear — wipe all episodes, chunks, and entity links
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function DELETE() {
  try {
    await db.chunkEntity.deleteMany({});
    await db.transcriptChunk.deleteMany({});
    await db.ingestionJob.deleteMany({});
    await db.episode.deleteMany({});

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[API] Clear all error:', error);
    return NextResponse.json({ error: 'Failed to clear' }, { status: 500 });
  }
}
