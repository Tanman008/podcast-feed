import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { fetchSearchEpisodes } from '@/lib/ingestion/searchIngestion';

async function main() {
  // Simulate what LLM would return for KO (Coca-Cola)
  const expansion = {
    inputType: 'company' as const,
    entityName: 'Coca-Cola',
    queries: ['Coca-Cola earnings revenue guidance'],
    feedTerms: ['Coca-Cola', 'beverage', 'consumer staples'],
    relatedPeople: ['James Quincey', 'Brian Smith', 'John Murphy'],
  };

  console.log('Fetching KO (Coca-Cola) + C-suite...\n');
  const eps = await fetchSearchEpisodes(expansion, 20);

  console.log(`Total: ${eps.length}\n`);
  for (const ep of eps.slice(0, 15)) {
    const date = new Date(ep.datePublished * 1000).toISOString().slice(0, 10);
    console.log(`  ${date}  ${(ep.feedTitle ?? '').slice(0, 28).padEnd(28)}  ${ep.title.slice(0, 55)}`);
  }
}
main();
