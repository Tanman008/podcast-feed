import '../src/lib/worker/env';
import { fetchSearchEpisodes } from '../src/lib/ingestion/searchIngestion';
import type { SearchExpansion } from '../src/lib/ingestion/searchExpander';

const CASES: SearchExpansion[] = [
  {
    inputType: 'company', entityName: 'NVIDIA Corporation (ticker: NVDA)',
    queries: ['NVIDIA datacenter GPU demand', 'NVIDIA Blackwell competitive moat'],
    feedTerms: ['NVIDIA', 'semiconductor'], relatedPeople: ['Jensen Huang', 'Colette Kress'],
  },
  {
    inputType: 'company', entityName: 'Coca-Cola Company (The) (ticker: KO)',
    queries: ['Coca-Cola revenue growth pricing', 'Coca-Cola brand strategy'],
    feedTerms: ['Coca-Cola', 'beverage'], relatedPeople: ['James Quincey', 'Brian Smith'],
  },
  {
    inputType: 'person', entityName: 'Satya Nadella',
    queries: ['Microsoft AI strategy', 'Azure cloud growth'],
    feedTerms: ['Microsoft', 'technology'], relatedPeople: [],
  },
];

async function main() {
  for (const exp of CASES) {
    console.log(`\n${'='.repeat(80)}\n${exp.entityName}  [${exp.inputType}]\n${'='.repeat(80)}`);
    const eps = await fetchSearchEpisodes(exp, 12);
    console.log(`  → ${eps.length} episodes after relevance filter:`);
    for (const e of eps) {
      const dur = Math.round((e.duration ?? 0) / 60);
      console.log(`    [${String(dur).padStart(3)}min] ${e.feedTitle?.slice(0,26).padEnd(26)} :: ${e.title?.slice(0,58)}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
