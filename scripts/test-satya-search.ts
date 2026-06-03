import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { searchPodcasts, getEpisodes } from '@/lib/podcast-index/client';

async function main() {
  const queries = ['Satya Nadella', 'Satya Nadella interview', 'Microsoft CEO', 'Microsoft podcast', 'technology executives'];
  for (const q of queries) {
    const feeds = await searchPodcasts(q).catch((e: any) => { console.log(`  ERROR: ${e.message}`); return []; });
    console.log(`\n"${q}" → ${feeds.length} feeds`);
    for (const f of feeds.slice(0, 4)) {
      console.log(`  [${f.id}] ${f.title.slice(0, 50)}`);
    }
  }

  // Also test: get episodes from the 2 feeds that "Satya Nadella" returns
  console.log('\n\n--- Episode fetch test for first 2 Satya Nadella feeds ---');
  const satyaFeeds = await searchPodcasts('Satya Nadella');
  for (const f of satyaFeeds.slice(0, 3)) {
    try {
      const eps = await getEpisodes(f.id, 3);
      console.log(`\n[${f.title.slice(0, 40)}]  ${eps.length} episodes`);
      for (const ep of eps) {
        console.log(`  ${ep.title.slice(0, 60)}  enclosure=${!!ep.enclosureUrl}`);
      }
    } catch (e: any) {
      console.log(`[${f.title}] getEpisodes error: ${e.message.slice(0, 60)}`);
    }
  }
}

main();

// Test new fetchSearchEpisodes approach
import { fetchSearchEpisodes } from '@/lib/ingestion/searchIngestion';
