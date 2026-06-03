// Backfills `horizon` and normalizes `claimType` for existing claims (no LLM cost).
// horizon is derived heuristically from the highlight; claimType strays are mapped onto
// the canonical eight. speakerRole is left null for legacy claims (needs context to infer).

import '../src/lib/worker/env';
import { db } from '../src/lib/db';
import { heuristicHorizon, normalizeClaimType } from '../src/lib/matching/engine';

async function main() {
  const claims = await db.claim.findMany({
    select: { id: true, highlight: true, numbers: true, claimType: true, horizon: true },
  });
  console.log(`Backfilling ${claims.length} claims...`);

  let horizonSet = 0, typeFixed = 0;
  const dist: Record<string, number> = {};

  for (const c of claims) {
    const horizon = heuristicHorizon(c.highlight, c.numbers ?? []);
    const normType = normalizeClaimType(c.claimType);
    dist[horizon] = (dist[horizon] ?? 0) + 1;

    const data: any = {};
    if (c.horizon !== horizon) { data.horizon = horizon; horizonSet++; }
    if (normType !== c.claimType) { data.claimType = normType; typeFixed++; }
    if (Object.keys(data).length) await db.claim.update({ where: { id: c.id }, data });
  }

  console.log(`  horizon set: ${horizonSet}, claimType normalized: ${typeFixed}`);
  console.log(`  horizon distribution: ${Object.entries(dist).map(([k,v]) => `${k}=${v}`).join('  ')}`);
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
