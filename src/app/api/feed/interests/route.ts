// GET /api/feed/interests?interestId=&limit=&offset=
// Returns InterestMatch rows with joined Claim data, newest episodes first.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const interestId = searchParams.get('interestId');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100'), 200);
  const offset = Math.max(parseInt(searchParams.get('offset') ?? '0'), 0);

  if (!interestId) {
    return NextResponse.json({ error: 'interestId required' }, { status: 400 });
  }

  const [matches, total] = await Promise.all([
    db.interestMatch.findMany({
      where: { interestId },
      orderBy: [{ episode: { publishedAt: 'desc' } }, { episode: { createdAt: 'desc' } }],
      take: limit,
      skip: offset,
      include: {
        episode: {
          include: { source: { select: { name: true, platform: true } } },
        },
        chunk: {
          select: {
            id: true, startTimeSeconds: true, endTimeSeconds: true,
            text: true, speakerLabel: true, speakerName: true, relevanceScore: true,
            keyPhrase: true,
          },
        },
        claim: {
          select: {
            id: true, highlight: true, primarySubject: true, mentionedEntities: true,
            claimType: true, specificity: true, completeness: true, gloss: true, numbers: true,
          },
        },
      },
    }),
    db.interestMatch.count({ where: { interestId } }),
  ]);

  return NextResponse.json({
    total,
    matches: matches.map(m => ({
      id: m.id,
      score: m.score,
      entityWeight: m.entityWeight,
      quality: m.quality ?? null,
      createdAt: m.createdAt,
      claim: {
        id: m.claim.id,
        highlight: m.claim.highlight,
        primarySubject: m.claim.primarySubject ?? null,
        mentionedEntities: m.claim.mentionedEntities,
        claimType: m.claim.claimType,
        specificity: m.claim.specificity,
        completeness: m.claim.completeness,
        gloss: m.claim.gloss ?? null,
        numbers: m.claim.numbers,
      },
      episode: {
        id: m.episode.id,
        externalId: m.episode.externalId,
        title: m.episode.title,
        publishedAt: m.episode.publishedAt,
        source: m.episode.source,
      },
      chunk: {
        id: m.chunk.id,
        startTimeSeconds: m.chunk.startTimeSeconds,
        endTimeSeconds: m.chunk.endTimeSeconds,
        text: m.chunk.text,
        speakerLabel: m.chunk.speakerLabel ?? null,
        speakerName: m.chunk.speakerName ?? null,
        authorityScore: m.chunk.relevanceScore ?? null,
        keyPhrase: m.chunk.keyPhrase ?? null,
      },
    })),
  });
}
