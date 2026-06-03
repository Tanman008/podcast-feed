import '../src/lib/worker/env';
import { db } from '../src/lib/db';

async function main() {
  const interests = await db.userInterest.findMany({
    select: { id: true, term: true, _count: { select: { matches: true } } },
  });
  console.log('=== ALL INTERESTS ===');
  for (const i of interests) console.log(`  ${i.term.padEnd(30)} matches=${i._count.matches}`);

  // NVDA feed top 15
  const nvda = interests.find(i => i.term.toUpperCase() === 'NVDA');
  if (nvda) {
    const matches = await db.interestMatch.findMany({
      where: { interestId: nvda.id },
      orderBy: { score: 'desc' },
      take: 15,
      select: {
        score: true, entityWeight: true, quality: true,
        claim: { select: { highlight: true, claimType: true, primarySubject: true, numbers: true, context: true } },
        chunk: { select: { noveltyScore: true } },
        episode: { select: { title: true, source: { select: { name: true } } } },
      },
    });
    console.log(`\n=== NVDA FEED — top 15 of ${nvda._count.matches} ===`);
    for (const m of matches) {
      const c = m.claim;
      console.log(`\n  score=${m.score.toFixed(3)} ew=${m.entityWeight.toFixed(2)} nov=${(m.chunk?.noveltyScore ?? -1).toFixed(2)} type=${c?.claimType} subj="${c?.primarySubject}"`);
      console.log(`    ${m.episode?.source?.name?.slice(0,30)} :: ${c?.highlight?.replace(/\s+/g,' ').slice(0,140)}`);
    }
  }

  // off-enum claim type examples
  const VALID = ['thesis','growth','position','transaction','competitive','guidance','valuation','unit_economics'];
  const offEnum = await db.claim.findMany({
    where: { claimType: { notIn: VALID } },
    select: { claimType: true, highlight: true, primarySubject: true },
    take: 20,
  });
  console.log(`\n=== OFF-ENUM CLAIM TYPES (${offEnum.length}) ===`);
  for (const c of offEnum) console.log(`  [${c.claimType}] subj=${c.primarySubject} :: ${c.highlight.replace(/\s+/g,' ').slice(0,90)}`);

  // novelty distribution
  const novRows = await db.transcriptChunk.findMany({ where: { noveltyScore: { not: null } }, select: { noveltyScore: true } });
  const novVals = novRows.map(r => r.noveltyScore!).sort((a,b)=>a-b);
  const nullNov = await db.transcriptChunk.count({ where: { noveltyScore: null } });
  if (novVals.length) {
    const pct = (p:number) => novVals[Math.floor(p*novVals.length)].toFixed(2);
    console.log(`\n=== NOVELTY DISTRIBUTION ===\n  n=${novVals.length} null=${nullNov}  min=${novVals[0].toFixed(2)} p25=${pct(.25)} p50=${pct(.5)} p75=${pct(.75)} max=${novVals[novVals.length-1].toFixed(2)}`);
  }

  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
