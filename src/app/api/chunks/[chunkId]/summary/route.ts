// POST /api/chunks/[chunkId]/summary
// Generates a 4-5 sentence AI summary of what's happening at a given moment:
// topic, speakers, context. Fetches 4 surrounding chunks for full context.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ chunkId: string }> }
) {
  const { chunkId } = await params;

  const chunk = await db.transcriptChunk.findUnique({
    where: { id: chunkId },
    select: {
      id: true, text: true, startTimeSeconds: true, chunkIndex: true,
      speakerName: true, speakerLabel: true, episodeId: true,
      episode: { select: { title: true, source: { select: { name: true } } } },
    },
  });
  if (!chunk) return NextResponse.json({ error: 'Chunk not found' }, { status: 404 });

  // Grab 4 surrounding chunks (2 before, 2 after) for context
  const [before, after] = await Promise.all([
    db.transcriptChunk.findMany({
      where: { episodeId: chunk.episodeId, chunkIndex: { lt: chunk.chunkIndex } },
      orderBy: { chunkIndex: 'desc' },
      take: 2,
      select: { text: true, speakerName: true, speakerLabel: true },
    }),
    db.transcriptChunk.findMany({
      where: { episodeId: chunk.episodeId, chunkIndex: { gt: chunk.chunkIndex } },
      orderBy: { chunkIndex: 'asc' },
      take: 2,
      select: { text: true, speakerName: true, speakerLabel: true },
    }),
  ]);

  const fmt = (c: { speakerName: string | null; speakerLabel: string | null; text: string }) => {
    const name = c.speakerName ?? (c.speakerLabel ? `Speaker ${c.speakerLabel}` : 'Unknown');
    return `${name}: ${c.text}`;
  };

  const transcript = [
    ...before.reverse().map(fmt),
    `>>> ${fmt(chunk)} <<<`,
    ...after.map(fmt),
  ].join('\n\n');

  const prompt = `You are summarizing a moment in a financial podcast.

Podcast: ${chunk.episode.source.name}
Episode: "${chunk.episode.title}"

Transcript excerpt (the highlighted section is the focal moment):
${transcript}

Write a 4-5 sentence summary covering:
1. The broader topic being discussed at this moment
2. Who is speaking and what their specific claim or view is
3. Any relevant context from the surrounding exchange

Be direct and specific — this is for an investor who wants to understand the signal quickly.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 300,
    temperature: 0.3,
  });

  const summary = response.choices[0]?.message?.content?.trim() ?? '';
  return NextResponse.json({ summary });
}
