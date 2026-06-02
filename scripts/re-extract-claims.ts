/**
 * scripts/re-extract-claims.ts
 *
 * Deletes all existing Claims (+ cascade-deletes InterestMatch rows) for each
 * completed episode, then re-runs claim extraction using the current prompt.
 *
 * Run this whenever the extraction prompt changes — no need to rechunk.
 * After this completes, run Re-scan on each interest to rebuild matches.
 *
 * Usage:
 *   npm run re-extract-claims
 *   npm run re-extract-claims -- --episode <id>
 */

import '../src/lib/worker/env';
import { db } from '../src/lib/db';
import { preExtractEpisodeClaims } from '../src/lib/matching/engine';
import pLimit from 'p-limit';

async function reExtractEpisode(episodeId: string, title: string): Promise<void> {
  const chunks = await db.transcriptChunk.findMany({
    where: { episodeId },
    select: { id: true },
  });

  if (chunks.length === 0) {
    console.log(`  [skip] no chunks`);
    return;
  }

  // Delete all claims — cascade removes InterestMatch rows too
  const deleted = await db.claim.deleteMany({
    where: { chunkId: { in: chunks.map(c => c.id) } },
  });
  console.log(`  deleted ${deleted.count} claims`);

  // Re-extract with current prompt
  const total = await preExtractEpisodeClaims(episodeId);
  console.log(`  extracted ${total} new claims`);
}

async function main() {
  const args = process.argv.slice(2);
  const singleEpisodeIdx = args.indexOf('--episode');
  const singleEpisodeId  = singleEpisodeIdx >= 0 ? args[singleEpisodeIdx + 1] : null;

  const episodes = await db.episode.findMany({
    where: {
      transcriptStatus: 'completed',
      ...(singleEpisodeId ? { id: singleEpisodeId } : {}),
    },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  });

  if (episodes.length === 0) {
    console.log('No completed episodes found.');
    process.exit(0);
  }

  console.log(`Re-extracting claims for ${episodes.length} episode(s)...\n`);

  for (const ep of episodes) {
    console.log(`[${ep.title}]`);
    try {
      await reExtractEpisode(ep.id, ep.title);
    } catch (err: any) {
      console.error(`  [error] ${err?.message ?? err}`);
    }
    console.log('');
  }

  console.log('Done. Run Re-scan on each interest to rebuild matches.');
  await db.$disconnect();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
