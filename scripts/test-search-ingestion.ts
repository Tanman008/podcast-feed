import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { fetchSearchEpisodes } from '@/lib/ingestion/searchIngestion';

const tests = [
  { entityName: 'NVIDIA', inputType: 'company' as const, queries: ['NVIDIA earnings'] },
  { entityName: 'Jensen Huang', inputType: 'person' as const, queries: ['Jensen Huang interview'] },
  { entityName: 'bitcoin', inputType: 'theme' as const, queries: ['bitcoin price analysis'] },
  { entityName: 'DoorDash', inputType: 'company' as const, queries: ['DoorDash delivery'] },
];

async function main() {
  for (const expansion of tests) {
    const eps = await fetchSearchEpisodes(expansion, 10);
    console.log(`\n[${expansion.entityName}]  found=${eps.length}`);
    for (const ep of eps.slice(0, 3)) {
      const date = new Date(ep.datePublished * 1000).toISOString().slice(0, 10);
      console.log(`  ${date}  ${ep.feedTitle.slice(0, 30).padEnd(30)}  ${ep.title.slice(0, 50)}`);
    }
  }
}

main();
