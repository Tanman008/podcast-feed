// scripts/download-tickers.ts
// Downloads the full US ticker→company name mapping from NASDAQ's screener API.
// Output: src/lib/tickers/us-tickers.json  (ticker → company name)
//
// Run with: npx tsx scripts/download-tickers.ts

import { writeFileSync } from 'fs';
import { join } from 'path';

const OUT_PATH = join(process.cwd(), 'src/lib/tickers/us-tickers.json');

const NASDAQ_API = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25000&download=true';

const CLEAN_RE = / (Common Stock|Class [A-Z] Common Stock|Ordinary Shares|American Depositary Shares?|ADR|Warrant|Rights|Units?|Series [A-Z].*)/i;

async function main() {
  console.log('Fetching US stock list from NASDAQ screener…');
  const res = await fetch(NASDAQ_API, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json, text/plain, */*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json() as { data: { rows: { symbol: string; name: string }[] } };
  const rows = json?.data?.rows ?? [];
  console.log(`  ${rows.length} tickers received`);

  const map: Record<string, string> = {};
  for (const { symbol, name } of rows) {
    if (!symbol || !name) continue;
    const clean = name.replace(CLEAN_RE, '').trim();
    map[symbol.trim()] = clean || name.trim();
  }

  console.log(`  ${Object.keys(map).length} unique symbols`);
  writeFileSync(OUT_PATH, JSON.stringify(map));
  console.log(`Saved to ${OUT_PATH}`);

  // Quick spot-check
  const checks = ['AAPL', 'NVDA', 'BDGI', 'MSFT', 'TSLA'];
  for (const sym of checks) {
    console.log(`  ${sym} → ${map[sym] ?? '(not found)'}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
