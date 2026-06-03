import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { searchItunesEpisodes } from '@/lib/podcast-index/client';

const AI_FARM_RE = /biography\s+flash|quiet\.\s*please|inception\s+point\s+ai/i;

async function main() {
  const name = 'Satya Nadella';
  const raw = await searchItunesEpisodes(name, 20);
  console.log(`Raw iTunes results: ${raw.length}\n`);

  // Show all with notes on quality
  for (const ep of raw) {
    const inTitle = ep.trackName.toLowerCase().includes('satya') || ep.trackName.toLowerCase().includes('nadella');
    const isFarm  = AI_FARM_RE.test(ep.collectionName);
    const flag    = isFarm ? '🤖' : inTitle ? '✓' : '~';
    console.log(`${flag}  ${ep.collectionName.slice(0, 30).padEnd(30)}  ${ep.trackName.slice(0, 55)}`);
  }

  console.log('\n--- After farm filter + title match ---');
  const filtered = raw.filter(ep => !AI_FARM_RE.test(ep.collectionName));
  const nameTokens = name.toLowerCase().split(/\s+/);
  const titleMatch = filtered.filter(ep => {
    const t = ep.trackName.toLowerCase();
    return nameTokens.some(tok => t.includes(tok));
  });
  console.log(`Farm filter: ${raw.length} → ${filtered.length}`);
  console.log(`Title match: ${filtered.length} → ${titleMatch.length}`);
  for (const ep of titleMatch) {
    const date = new Date(ep.releaseDate).toISOString().slice(0,10);
    console.log(`  ${date}  ${ep.collectionName.slice(0,28).padEnd(28)}  ${ep.trackName.slice(0,55)}`);
  }
}
main();
