// GET /api/interests/[interestId]/digest
// Measures real-world podcast buzz for an interest term via Podcast Index feed search.
// Returns how many podcasts covering this topic have published in the last 7 days / 24h.
// Tickers are expanded to company names before searching (MSFT → Microsoft).
// Uses a 1-hour in-memory cache per interest.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { lookupTicker } from '@/lib/tickers/lookup';
import { TOPIC_EXPANSIONS } from '@/lib/matching/topicExpansions';
import crypto from 'crypto';

export interface DigestData {
  todayCount: number;
  weekCount: number;
  searchTerm: string;   // what was actually searched on PI (after expansion)
  generatedAt: string;
}

const cache = new Map<string, { data: DigestData; expiresAt: number }>();
const TTL_MS = 60 * 60 * 1000;

async function piSearchByTerm(term: string, max = 40): Promise<{ newestItemPubdate: number }[]> {
  const key       = process.env.PODCAST_INDEX_API_KEY;
  const secretB64 = process.env.PODCAST_INDEX_API_SECRET_B64;
  const rawSecret = process.env.PODCAST_INDEX_API_SECRET;
  const secret    = secretB64 ? Buffer.from(secretB64, 'base64').toString('utf8') : rawSecret;
  if (!key || !secret) return [];

  const epoch = Math.floor(Date.now() / 1000).toString();
  const hash  = crypto.createHash('sha1').update(key + secret + epoch).digest('hex');
  const qs    = new URLSearchParams({ q: term, max: String(max) }).toString();
  const url   = `https://api.podcastindex.org/api/1.0/search/byterm?${qs}`;

  const res = await fetch(url, {
    headers: { 'X-Auth-Key': key, 'X-Auth-Date': epoch, Authorization: hash, 'User-Agent': 'PodcastFeedApp/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.feeds ?? [];
}

function expandTerm(raw: string): string {
  const lower = raw.trim().toLowerCase();

  // Topic key takes priority — avoids false ticker matches (e.g. "AI" → C3.ai stock).
  // Use the raw term directly: PI keyword search on "quantum" returns more than "quantum computing".
  if (TOPIC_EXPANSIONS[lower]) return raw.trim();

  // Ticker → company first word (MSFT → Microsoft, NVDA → NVIDIA, DASH → DoorDash)
  const company = lookupTicker(raw.trim().toUpperCase());
  if (company) return company.split(/\s+/)[0];

  return raw.trim();
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ interestId: string }> }
) {
  const { interestId } = await params;

  const cached = cache.get(interestId);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.data);
  }

  const interest = await db.userInterest.findUnique({
    where: { id: interestId },
    select: { term: true },
  });

  if (!interest) {
    return NextResponse.json({ error: 'Interest not found' }, { status: 404 });
  }

  const searchTerm = expandTerm(interest.term);
  const nowSecs    = Math.floor(Date.now() / 1000);
  const oneDayAgo  = nowSecs - 24 * 60 * 60;
  const sevenDaysAgo = nowSecs - 7 * 24 * 60 * 60;

  let todayCount = 0;
  let weekCount  = 0;

  try {
    const feeds = await piSearchByTerm(searchTerm, 40);
    for (const f of feeds) {
      if (f.newestItemPubdate >= sevenDaysAgo) weekCount++;
      if (f.newestItemPubdate >= oneDayAgo)   todayCount++;
    }
  } catch {
    // PI unavailable — return zero counts
  }

  const data: DigestData = { todayCount, weekCount, searchTerm, generatedAt: new Date().toISOString() };
  cache.set(interestId, { data, expiresAt: Date.now() + TTL_MS });
  return NextResponse.json(data);
}
