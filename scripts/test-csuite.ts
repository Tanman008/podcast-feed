import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { fetchSearchEpisodes } from '@/lib/ingestion/searchIngestion';

async function main() {
  // Simulate what the LLM returns for MSFT
  const expansion = {
    inputType: 'company' as const,
    entityName: 'Microsoft',
    queries: ['Microsoft earnings revenue AI'],
    feedTerms: ['Microsoft', 'technology', 'enterprise software'],
    relatedPeople: ['Satya Nadella', 'Amy Hood', 'Brad Smith'],
  };
  console.log('Fetching MSFT + C-suite...');
  const eps = await fetchSearchEpisodes(expansion, 30);
  console.log(`\nTotal: ${eps.length} episodes\n`);
  for (const ep of eps.slice(0, 12)) {
    const date = new Date(ep.datePublished * 1000).toISOString().slice(0, 10);
    console.log(`  ${date}  ${(ep.feedTitle ?? '').slice(0, 30).padEnd(30)}  ${ep.title.slice(0, 50)}`);
  }
}
main();
