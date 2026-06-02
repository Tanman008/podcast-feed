// DELETE /api/episodes/[episodeId] — remove episode and all associated data
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ episodeId: string }> }
) {
  const { episodeId } = await params;

  try {
    // Must delete in FK order: ChunkEntity → TranscriptChunk → Episode
    const chunks = await db.transcriptChunk.findMany({
      where: { episodeId },
      select: { id: true },
    });

    const chunkIds = chunks.map(c => c.id);

    await db.chunkEntity.deleteMany({ where: { chunkId: { in: chunkIds } } });
    await db.transcriptChunk.deleteMany({ where: { episodeId } });
    await db.ingestionJob.deleteMany({ where: { episodeId } });
    await db.episode.delete({ where: { id: episodeId } });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[API] Delete episode error:', error);
    return NextResponse.json({ error: 'Failed to delete episode' }, { status: 500 });
  }
}
