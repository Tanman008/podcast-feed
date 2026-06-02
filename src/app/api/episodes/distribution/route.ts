// GET /api/episodes/distribution
// Returns episode count grouped by month for the histogram date slider.
// Falls back to createdAt when publishedAt is null.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  const episodes = await db.episode.findMany({
    where: { transcriptStatus: 'completed' },
    select: { publishedAt: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const counts: Record<string, number> = {};
  for (const ep of episodes) {
    const date = ep.publishedAt ?? ep.createdAt;
    const month = date.toISOString().slice(0, 7); // YYYY-MM
    counts[month] = (counts[month] ?? 0) + 1;
  }

  const months = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({ month, count }));

  return NextResponse.json({ months });
}
