import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { fetchSearchEpisodes } from '@/lib/ingestion/searchIngestion';

async function main() {
  const tests = [
    { entityName: 'Satya Nadella', inputType: 'person' as const, queries: [], feedTerms: [] },
    { entityName: 'Jensen Huang', inputType: 'person' as const, queries: [], feedTerms: [] },
    { entityName: 'NVIDIA', inputType: 'company' as const, queries: [], feedTerms: ['NVIDIA', 'semiconductor', 'AI'] },
    { entityName: 'bitcoin', inputType: 'theme' as const, queries: [], feedTerms: ['bitcoin', 'crypto'] },
  ];
  for (const expansion of tests) {
    const eps = await fetchSearchEpisodes(expansion, 10);
    console.log(`\n[${expansion.entityName}]  found=${eps.length}`);
    for (const ep of eps.slice(0, 3)) {
      const date = new Date(ep.datePublished * 1000).toISOString().slice(0, 10);
      console.log(`  ${date}  ${(ep.feedTitle ?? '').slice(0, 28).padEnd(28)}  ${ep.title.slice(0, 50)}`);
    }
  }
}
main();
