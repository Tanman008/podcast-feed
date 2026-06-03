// POST /api/ingest/search — create a search subscription and queue initial episodes
// Body: { query: string }
// Creates or reuses a Source with sourceType='search', then ingests the top 10 matching episodes.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { expandSearchTerm } from '@/lib/ingestion/searchExpander';
import { fetchSearchEpisodes } from '@/lib/ingestion/searchIngestion';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function upsertSearchSource(entityName: string, query: string): Promise<{ id: string; name: string }> {
  const canonicalUrl = `search://${slugify(entityName)}`;

  const existing = await db.source.findFirst({
    where: { url: canonicalUrl },
    select: { id: true, name: true },
  });
  if (existing) return existing;

  const baseSlug = `${slugify(entityName)}-search`;
  let slug = baseSlug;
  let attempts = 0;

  while (attempts < 5) {
    try {
      const source = await db.source.create({
        data: {
          name:               `${entityName} (search)`,
          slug,
          sourceType:         'search',
          platform:           'podcast_index',
          url:                canonicalUrl,
          searchQuery:        query,
          following:          true,
          minDurationSeconds: 20 * 60,  // 20 min — filters news clips, AI summaries
        },
      });
      return { id: source.id, name: source.name };
    } catch (e: any) {
      if (e?.code === 'P2002') {
        slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
        attempts++;
      } else {
        throw e;
      }
    }
  }
  throw new Error(`Could not create search source for: ${entityName}`);
}

export async function POST(req: NextRequest) {
  try {
    const { query, sinceMonths } = await req.json();
    if (!query?.trim()) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const sinceTimestamp = sinceMonths
      ? Math.floor(Date.now() / 1000) - sinceMonths * 30 * 24 * 3600
      : undefined;

    const expansion = await expandSearchTerm(query.trim());
    console.log(`[Search] "${query}" → ${expansion.entityName} (${expansion.inputType}): ${expansion.queries.join(', ')}`);

    const source = await upsertSearchSource(expansion.entityName, query.trim());

    const episodes = await fetchSearchEpisodes(expansion, 20, sinceTimestamp);
    if (episodes.length === 0) {
      return NextResponse.json({
        sourceId:   source.id,
        sourceName: source.name,
        queued:     0,
        expansion,
        message: 'No episodes found for this search term.',
      });
    }

    // Dedup against episodes already ingested for this source
    const existingIds = new Set(
      (await db.episode.findMany({
        where: { sourceId: source.id, externalId: { in: episodes.map(e => String(e.id)) } },
        select: { externalId: true },
      })).map(e => e.externalId)
    );

    const MIN_DURATION_SECS = 20 * 60;

    let queued = 0;
    for (const ep of episodes) {
      const externalId = String(ep.id);
      if (existingIds.has(externalId)) continue;
      if (!ep.enclosureUrl) continue;
      if (ep.duration && ep.duration < MIN_DURATION_SECS) continue;

      const episode = await db.episode.upsert({
        where: { sourceId_externalId: { sourceId: source.id, externalId } },
        update: {},
        create: {
          sourceId: source.id,
          externalId,
          title:           ep.title || 'Untitled Episode',
          description:     ep.description || null,
          publishedAt:     ep.datePublished ? new Date(ep.datePublished * 1000) : null,
          durationSeconds: ep.duration || null,
          thumbnailUrl:    ep.image || null,
          transcriptStatus: 'pending',
        },
      });

      await db.ingestionJob.create({
        data: {
          episodeUrl: ep.enclosureUrl,
          sourceId:   source.id,
          episodeId:  episode.id,
          status:     'queued',
        },
      });
      queued++;
    }

    await db.source.update({ where: { id: source.id }, data: { lastCheckedAt: new Date() } });

    console.log(`[Search] "${expansion.entityName}": ${queued} episodes queued`);

    return NextResponse.json({ sourceId: source.id, sourceName: source.name, queued, expansion }, { status: 202 });
  } catch (err: any) {
    console.error('[Search] Error:', err);
    return NextResponse.json({ error: err.message ?? 'Search ingestion failed' }, { status: 500 });
  }
}
