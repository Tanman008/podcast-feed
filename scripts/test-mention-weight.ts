import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { db } from '@/lib/db';

// Simulate computeEntityWeight logic to see score impact
function entityGate(ew: number): number {
  return ew >= 0.50 ? 1.0 : ew >= 0.25 ? 0.60 : 0.10;
}

async function main() {
  // Find interest matches for Elon Musk or similar
  const interests = await db.userInterest.findMany({ select: { id: true, term: true } });
  console.log('Interests:', interests.map(i => i.term).join(', '));

  for (const interest of interests) {
    const matches = await db.interestMatch.findMany({
      where: { interestId: interest.id },
      orderBy: { score: 'desc' },
      take: 20,
      select: {
        score: true,
        entityWeight: true,
        claim: { select: { primarySubject: true, claimType: true, highlight: true } },
      },
    });

    // Identify mention-only matches (ew between 0.25 and 0.60)
    const mentionMatches = matches.filter(m => m.entityWeight >= 0.30 && m.entityWeight <= 0.60);
    if (mentionMatches.length === 0) continue;

    console.log(`\n[${interest.term}] — ${mentionMatches.length} mention-range matches (ew 0.30-0.60):`);
    for (const m of mentionMatches.slice(0, 5)) {
      const oldEw = 0.55;
      const newEw = m.claim?.claimType === 'transaction' ? 0.80 : 0.35;
      const oldGate = entityGate(oldEw);
      const newGate = entityGate(newEw);
      const scoreRatio = (newEw * newGate) / (oldEw * oldGate);
      console.log(`  ew=${m.entityWeight.toFixed(2)}  score=${m.score.toFixed(3)}  ` +
        `→ new score ~${(m.score * scoreRatio).toFixed(3)}  ` +
        `subject="${m.claim?.primarySubject ?? 'none'}"  type=${m.claim?.claimType}`);
      console.log(`    "${m.claim?.highlight?.slice(0, 80)}..."`);
    }
  }

  await db.$disconnect();
}
main();
// Already ran above — checking the primary subject matches separately
