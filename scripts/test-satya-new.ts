import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { fetchSearchEpisodes } from '@/lib/ingestion/searchIngestion';

async function main() {
  const eps = await fetchSearchEpisodes({
    inputType: 'person', entityName: 'Satya Nadella',
    queries: [], feedTerms: [],
  }, 10);
  console.log(`Found: ${eps.length}\n`);
  for (const ep of eps) {
    const date = ep.datePublished
      ? new Date(ep.datePublished * 1000).toISOString().slice(0, 10)
      : 'no date';
    const src = ep.feedId ? 'PI' : 'iTunes fallback';
    console.log(`${date} [${src}]  ${ep.feedTitle.slice(0, 28).padEnd(28)}  ${ep.title.slice(0, 45)}`);
  }
}
main();
