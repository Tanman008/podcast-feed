import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { db } from '@/lib/db';
import { backfillInterest } from '@/lib/matching/engine';

async function main() {
  const interest = await db.userInterest.findFirst({ where: { term: 'Elon Musk' } });
  if (!interest) { console.log('No Elon Musk interest'); return; }

  console.log('Deleting existing matches...');
  await db.interestMatch.deleteMany({ where: { interestId: interest.id } });

  console.log('Re-running backfill with new weights...');
  const count = await backfillInterest(interest.id, interest.term);
  console.log(`Done — ${count} matches created`);

  // Show top results
  const matches = await db.interestMatch.findMany({
    where: { interestId: interest.id },
    orderBy: { score: 'desc' },
    take: 12,
    select: {
      score: true,
      entityWeight: true,
      claim: { select: { primarySubject: true, highlight: true } },
    },
  });

  console.log('\nTop 12 after reindex:\n');
  for (const m of matches) {
    const tier = m.entityWeight >= 0.90 ? 'SUBJ' : m.entityWeight >= 0.50 ? 'MHIGH' : m.entityWeight >= 0.25 ? 'MLOW' : 'SEM';
    console.log(`  ${m.score.toFixed(3)} ew=${m.entityWeight.toFixed(2)} [${tier.padEnd(5)}] "${m.claim?.highlight?.slice(0, 65) ?? ''}"`);
  }

  await db.$disconnect();
}
main();
