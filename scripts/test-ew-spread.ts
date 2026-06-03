import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { db } from '@/lib/db';

async function main() {
  const interest = await db.userInterest.findFirst({ where: { term: 'Elon Musk' } });
  if (!interest) { console.log('No Elon Musk interest found'); return; }

  const matches = await db.interestMatch.findMany({
    where: { interestId: interest.id },
    orderBy: { score: 'desc' },
    take: 15,
    select: {
      score: true,
      entityWeight: true,
      claim: { select: { primarySubject: true, claimType: true, highlight: true } },
    },
  });

  console.log('Top 15 Elon Musk matches by current score:\n');
  for (const m of matches) {
    const ew = m.entityWeight.toFixed(2);
    const tier = m.entityWeight >= 0.90 ? 'SUBJECT' 
               : m.entityWeight >= 0.50 ? 'MENTION-HIGH'
               : m.entityWeight >= 0.25 ? 'MENTION-LOW'
               : 'SEMANTIC';
    console.log(`  ${m.score.toFixed(3)}  ew=${ew} [${tier.padEnd(12)}]  "${m.claim?.primarySubject ?? '—'}"  ${m.claim?.highlight?.slice(0, 60) ?? ''}`);
  }
  await db.$disconnect();
}
main();
