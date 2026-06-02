import '../src/lib/worker/env'; // load .env.local — must be first import
import { db } from '../src/lib/db';

async function run() {
  const episodes = await db.episode.findMany({
    where: { title: { startsWith: 'Video ' } },
    select: { id: true, externalId: true },
  });

  console.log(`Backfilling ${episodes.length} episode title(s)...`);

  for (const ep of episodes) {
    try {
      const oembedUrl =
        'https://www.youtube.com/oembed?url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + ep.externalId) +
        '&format=json';

      const res = await fetch(oembedUrl);
      if (!res.ok) {
        console.log(`  skip ${ep.externalId} (${res.status})`);
        continue;
      }

      const data = (await res.json()) as { title?: string };
      if (!data.title) continue;

      await db.episode.update({ where: { id: ep.id }, data: { title: data.title } });
      console.log(`  ✓ ${ep.externalId} → ${data.title}`);
    } catch (e: any) {
      console.error(`  ✗ ${ep.externalId}:`, e.message);
    }
  }

  await db.$disconnect();
  console.log('Done.');
}

run();
