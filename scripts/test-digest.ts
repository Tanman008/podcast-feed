// npx tsx scripts/test-digest.ts
// Tests the PI digest expansion and buzz counts for all current interests.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import crypto from 'crypto';
import { db } from '@/lib/db';
import { lookupTicker } from '@/lib/tickers/lookup';
import { TOPIC_EXPANSIONS } from '@/lib/matching/topicExpansions';

function expandTerm(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (TOPIC_EXPANSIONS[lower]) return raw.trim();
  const company = lookupTicker(raw.trim().toUpperCase());
  if (company) return company.split(/\s+/)[0];
  return raw.trim();
}

async function piSearchByTerm(term: string, max = 40): Promise<{ newestItemPubdate: number }[]> {
  const key       = process.env.PODCAST_INDEX_API_KEY!;
  const secretB64 = process.env.PODCAST_INDEX_API_SECRET_B64;
  const rawSecret = process.env.PODCAST_INDEX_API_SECRET;
  const secret    = secretB64 ? Buffer.from(secretB64, 'base64').toString('utf8') : rawSecret!;
  const epoch     = Math.floor(Date.now() / 1000).toString();
  const hash      = crypto.createHash('sha1').update(key + secret + epoch).digest('hex');
  const qs        = new URLSearchParams({ q: term, max: String(max) }).toString();
  const res       = await fetch(`https://api.podcastindex.org/api/1.0/search/byterm?${qs}`, {
    headers: { 'X-Auth-Key': key, 'X-Auth-Date': epoch, Authorization: hash, 'User-Agent': 'PodcastFeedApp/1.0' },
  });
  if (!res.ok) throw new Error(`PI ${res.status}`);
  return (await res.json()).feeds ?? [];
}

async function main() {
  const interests = await db.userInterest.findMany({ select: { term: true } });
  // Also test some hypothetical terms
  const extras = ['NVDA', 'bitcoin', 'AI', 'defense'];
  const terms = [...interests.map(i => i.term), ...extras];

  const nowSecs      = Math.floor(Date.now() / 1000);
  const oneDayAgo    = nowSecs - 86400;
  const sevenDaysAgo = nowSecs - 7 * 86400;

  console.log(`${'Term'.padEnd(14)} ${'→ Search'.padEnd(22)} feeds  today  week`);
  console.log('─'.repeat(65));

  for (const term of terms) {
    const searchTerm = expandTerm(term);
    try {
      const feeds = await piSearchByTerm(searchTerm, 40);
      const today = feeds.filter(f => f.newestItemPubdate >= oneDayAgo).length;
      const week  = feeds.filter(f => f.newestItemPubdate >= sevenDaysAgo).length;
      console.log(`${term.padEnd(14)} → ${searchTerm.padEnd(22)} ${String(feeds.length).padStart(5)}  ${String(today).padStart(5)}  ${String(week).padStart(4)}`);
    } catch (e: any) {
      console.log(`${term.padEnd(14)} → ${searchTerm.padEnd(22)} ERROR: ${e.message}`);
    }
  }

  await db.$disconnect();
}

main();
