/**
 * scripts/reindex-interests.ts
 *
 * Re-runs interest matching for all interests against all completed episodes.
 * Use this after changing the scoring formula to rebuild InterestMatch scores.
 *
 * Usage:
 *   npm run reindex-interests
 *   npm run reindex-interests -- --interest "SpaceX"
 *   npm run reindex-interests -- --episode <episodeId>
 */

import '../src/lib/worker/env';
import { db } from '../src/lib/db';
import { matchInterestAgainstEpisodes } from '../src/lib/matching/engine';

async function main() {
  const args = process.argv.slice(2);
  const get  = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

  const interestFilter = get('--interest');
  const episodeFilter  = get('--episode');

  const interests = await db.userInterest.findMany({
    where: interestFilter ? { term: { equals: interestFilter, mode: 'insensitive' } } : {},
    select: { id: true, term: true },
  });

  if (interests.length === 0) {
    console.error(interestFilter ? `No interest found: "${interestFilter}"` : 'No interests found');
    process.exit(1);
  }

  const episodes = await db.episode.findMany({
    where: {
      transcriptStatus: 'completed',
      ...(episodeFilter ? { id: episodeFilter } : {}),
    },
    select: { id: true, title: true },
  });

  if (episodes.length === 0) {
    console.log('No completed episodes found.');
    process.exit(0);
  }

  console.log(`\nReindexing ${interests.length} interest(s) × ${episodes.length} episode(s)...\n`);

  for (const interest of interests) {
    console.log(`  [${interest.term}]`);
    await matchInterestAgainstEpisodes(interest.id, interest.term, episodes.map(e => e.id));
    console.log(`  [${interest.term}] done`);
  }

  console.log('\nReindex complete.\n');
  await db.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
