// prisma/seed.ts
// Run with: npx prisma db seed
// Bootstraps initial Source records and a test Episode for development

import { PrismaClient, SourceType, TranscriptStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ── Seed Sources ──────────────────────────────────────────────────────────

  const allIn = await prisma.source.upsert({
    where: { slug: 'all-in-podcast' },
    update: {},
    create: {
      name: 'All-In Podcast',
      slug: 'all-in-podcast',
      sourceType: SourceType.youtube,
      platform: 'youtube',
      url: 'https://www.youtube.com/@allin',
      description: 'Chamath, Jason, Sacks & Friedberg on markets, tech, politics.',
    },
  });

  const acquired = await prisma.source.upsert({
    where: { slug: 'acquired' },
    update: {},
    create: {
      name: 'Acquired',
      slug: 'acquired',
      sourceType: SourceType.youtube,
      platform: 'youtube',
      url: 'https://www.youtube.com/@AcquiredFM',
      description: 'Deep dives on great tech companies.',
    },
  });

  const dwarkesh = await prisma.source.upsert({
    where: { slug: 'dwarkesh-podcast' },
    update: {},
    create: {
      name: 'Dwarkesh Podcast',
      slug: 'dwarkesh-podcast',
      sourceType: SourceType.youtube,
      platform: 'youtube',
      url: 'https://www.youtube.com/@DwarkeshPatel',
      description: 'Long-form interviews with scientists, economists, and founders.',
    },
  });

  console.log('Sources created:', { allIn: allIn.id, acquired: acquired.id, dwarkesh: dwarkesh.id });

  // ── Seed Test Episode (for ingestion pipeline dev/testing) ────────────────
  // Known good video with reliable captions. Use to validate ingestion end-to-end.

  const testEpisode = await prisma.episode.upsert({
    where: {
      sourceId_externalId: {
        sourceId: allIn.id,
        externalId: 'TbKMBR4k5_k', // All-In E166 — known to have full captions
      },
    },
    update: {},
    create: {
      sourceId: allIn.id,
      externalId: 'TbKMBR4k5_k',
      title: 'All-In E166 (seed — replace with real ingest)',
      transcriptStatus: TranscriptStatus.pending,
    },
  });

  console.log('Test episode created:', testEpisode.id);

  // ── Seed Entities ─────────────────────────────────────────────────────────
  // Seed commonly referenced tickers so ChunkEntity links resolve immediately.

  const tickers = [
    { ticker: 'NVDA', name: 'NVIDIA', normalizedName: 'nvidia' },
    { ticker: 'TSLA', name: 'Tesla', normalizedName: 'tesla' },
    { ticker: 'META', name: 'Meta Platforms', normalizedName: 'meta platforms' },
    { ticker: 'MSFT', name: 'Microsoft', normalizedName: 'microsoft' },
    { ticker: 'GOOGL', name: 'Alphabet', normalizedName: 'alphabet' },
    { ticker: 'AMZN', name: 'Amazon', normalizedName: 'amazon' },
    { ticker: 'AAPL', name: 'Apple', normalizedName: 'apple' },
    { ticker: 'OPENAI', name: 'OpenAI', normalizedName: 'openai' },
  ];

  for (const t of tickers) {
    await prisma.entity.upsert({
      where: { normalizedName_entityType: { normalizedName: t.normalizedName, entityType: 'ticker' } },
      update: {},
      create: {
        entityType: 'ticker',
        name: t.name,
        normalizedName: t.normalizedName,
        ticker: t.ticker,
      },
    });
  }

  console.log(`Seeded ${tickers.length} ticker entities.`);
  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
