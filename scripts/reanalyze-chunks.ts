/**
 * scripts/reanalyze-chunks.ts
 *
 * Re-runs the LLM analysis call on existing chunks and writes back all
 * LLM-derived fields: keyQuote, keyPhrase, convictionScore, entities.
 *
 * As the prompt evolves or new fields are added to the schema, update
 * analyzeChunk in entityExtractor.ts and re-run this script.
 *
 * Usage:
 *   npm run reanalyze                        # backfill only chunks missing keyQuote
 *   npm run reanalyze -- --all               # re-run on every chunk
 *   npm run reanalyze -- --episode <id>      # one episode only
 *   npm run reanalyze -- --dry-run           # print counts, touch nothing
 *
 * The script reads .env.local automatically.
 */

import '../src/lib/worker/env'; // load .env.local before anything else
import pLimit from 'p-limit';
import { db } from '../src/lib/db';
import { analyzeChunk, type EntityExtractionResult } from '../src/lib/ingestion/entityExtractor';
import type { RawChunk } from '../src/lib/ingestion/chunker';

const CONCURRENCY = 8;

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ALL       = args.includes('--all');
const DRY_RUN   = args.includes('--dry-run');
const EP_IDX    = args.indexOf('--episode');
const EPISODE_ID = EP_IDX !== -1 ? args[EP_IDX + 1] : undefined;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function progress(done: number, total: number) {
  const pct = ((done / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${done}/${total} (${pct}%)`);
}

async function persistAnalysis(chunkId: string, analysis: EntityExtractionResult) {
  // 1. Update LLM-derived scalar fields on the chunk
  await db.transcriptChunk.update({
    where: { id: chunkId },
    data: {
      keyQuote: analysis.keyQuote ?? null,
      keyPhrase: analysis.keyPhrase ?? null,
      convictionScore: analysis.forwardLookingScore,
    },
  });

  // 2. Upsert entities + ChunkEntity links
  for (const e of analysis.entities) {
    const entity = await db.entity.upsert({
      where: {
        normalizedName_entityType: {
          normalizedName: e.normalizedName,
          entityType: e.entityType,
        },
      },
      update: { ticker: e.ticker || null },
      create: {
        name: e.name,
        normalizedName: e.normalizedName,
        entityType: e.entityType,
        ticker: e.ticker || null,
      },
    });

    await db.chunkEntity.upsert({
      where: { chunkId_entityId: { chunkId, entityId: entity.id } },
      update: { confidence: e.confidence, mentionType: e.mentionType },
      create: { chunkId, entityId: entity.id, confidence: e.confidence, mentionType: e.mentionType },
    });
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Build the filter
  const where: Record<string, unknown> = {};
  if (EPISODE_ID) {
    where.episodeId = EPISODE_ID;
    console.log(`\nScope: episode ${EPISODE_ID}`);
  } else if (!ALL) {
    where.keyQuote = null;
    console.log('\nScope: chunks missing keyQuote (pass --all to force-update everything)');
  } else {
    console.log('\nScope: all chunks (--all)');
  }
  if (DRY_RUN) console.log('Mode: dry-run (no writes)');

  const chunks = await db.transcriptChunk.findMany({
    where,
    select: { id: true, text: true, cleanedText: true },
    orderBy: { createdAt: 'asc' },
  });

  const total = chunks.length;
  console.log(`\nFound ${total} chunk(s) to reanalyze.\n`);
  if (total === 0 || DRY_RUN) {
    await db.$disconnect();
    return;
  }

  const limiter = pLimit(CONCURRENCY);
  let done = 0;
  let errors = 0;

  const tasks = chunks.map(chunk =>
    limiter(async () => {
      try {
        // Pass original-case text so the LLM produces readable keyQuotes
        const rawChunk: RawChunk = {
          text: chunk.text,
          cleanedText: chunk.cleanedText,
          startTimeSeconds: 0,
          endTimeSeconds: 0,
          tokenCount: 0,
          chunkIndex: 0,
        };

        const analysis = await analyzeChunk(rawChunk);
        await persistAnalysis(chunk.id, analysis);
      } catch (err: any) {
        errors++;
        console.error(`\n  ✗ chunk ${chunk.id}: ${err?.message}`);
      } finally {
        done++;
        progress(done, total);
      }
    })
  );

  await Promise.all(tasks);

  console.log(`\n\n✅ Done. ${done - errors}/${total} updated, ${errors} error(s).`);
  await db.$disconnect();
}

main().catch(async err => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
