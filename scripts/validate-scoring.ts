import '../src/lib/worker/env';
import { db } from '../src/lib/db';
import { matchInterestAgainstEpisodes } from '../src/lib/matching/engine';

async function topMatches(interestId: string, n: number) {
  return db.interestMatch.findMany({
    where: { interestId }, orderBy: { score: 'desc' }, take: n,
    select: {
      score: true, entityWeight: true,
      claim: { select: { highlight: true, claimType: true, primarySubject: true, horizon: true } },
      episode: { select: { source: { select: { name: true } } } },
    },
  });
}

function row(m: any): string {
  const c = m.claim;
  const hor = c?.horizon ?? '·';
  return `  ${m.score.toFixed(3)} ew=${m.entityWeight.toFixed(2)} [${c?.claimType?.slice(0,11).padEnd(11)}] hor=${String(hor).slice(0,5).padEnd(5)} subj=${(c?.primarySubject??'?').slice(0,18).padEnd(18)} :: ${c?.highlight?.replace(/\s+/g,' ').slice(0,72)}`;
}

async function main() {
  const term = process.argv[2] || 'NVDA';
  const interest = await db.userInterest.findFirst({ where: { term: { equals: term, mode: 'insensitive' } }, select: { id: true, term: true } });
  if (!interest) { console.log(`No interest "${term}"`); process.exit(0); }

  console.log(`\n### BEFORE (stored scores) — ${interest.term} ###`);
  for (const m of await topMatches(interest.id, 10)) console.log(row(m));

  // Clean re-scan: delete existing matches, re-run with new engine
  await db.interestMatch.deleteMany({ where: { interestId: interest.id } });
  const written = await matchInterestAgainstEpisodes(interest.id, interest.term, null);
  console.log(`\n[re-scan wrote ${written} matches]`);

  console.log(`\n### AFTER (new engine) — ${interest.term} ###`);
  for (const m of await topMatches(interest.id, 12)) console.log(row(m));

  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
