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
          include: { source: { select: { name: true, platform: true, feedUrl: true } } },
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
            id: true, highlight: true, context: true, primarySubject: true, mentionedEntities: true,
            claimType: true, specificity: true, completeness: true, gloss: true, numbers: true,
          },
        },
      },
    }),
    db.interestMatch.count({ where: { interestId } }),
  ]);

  return NextResponse.json({
    total,
    matches: matches.flatMap(m => {
      if (!m.claim) return [];
      const claim = m.claim;
      return [{
        id: m.id,
        score: m.score,
        entityWeight: m.entityWeight,
        quality: m.quality ?? null,
        createdAt: m.createdAt,
        sourceFollowed: !!(m.episode.source as any)?.feedUrl,
        claim: {
          id: claim.id,
          highlight: claim.highlight,
          context: claim.context ?? null,
          primarySubject: claim.primarySubject ?? null,
          mentionedEntities: claim.mentionedEntities,
          claimType: claim.claimType,
          specificity: claim.specificity,
          completeness: claim.completeness,
          gloss: claim.gloss ?? null,
          numbers: claim.numbers,
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
      }];
    }),
  });
}
