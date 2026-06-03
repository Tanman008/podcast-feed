import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { db } from '@/lib/db';

function matchReason(interestTerm: string, primarySubject: string | null, mentionedEntities: string[], highlight: string): string | null {
  const term        = interestTerm.toLowerCase();
  const tokens      = term.split(/\s+/).filter(w => w.length > 2);
  const subject     = primarySubject ?? '';
  const subjectLow  = subject.toLowerCase();
  const highlightLow = highlight.toLowerCase();

  const isSubject = tokens.some(t =>
    subjectLow.includes(t) || t.includes(subjectLow.split(/\s+/)[0] ?? '')
  );

  if (isSubject) {
    const firstToken = subjectLow.split(/\s+/)[0] ?? '';
    if (firstToken && !highlightLow.includes(firstToken)) {
      return `attributed to ${subject}`;
    }
    return null;
  }

  const matching = mentionedEntities.find(e =>
    tokens.some(t => e.toLowerCase().includes(t))
  );
  if (matching) return `${matching} mentioned in transcript`;
  return null;
}

async function main() {
  const interest = await db.userInterest.findFirst({ where: { term: 'Elon Musk' } });
  if (!interest) return;

  const matches = await db.interestMatch.findMany({
    where: { interestId: interest.id },
    orderBy: { score: 'desc' },
    take: 15,
    select: {
      score: true,
      entityWeight: true,
      claim: { select: { primarySubject: true, mentionedEntities: true, highlight: true } },
    },
  });

  console.log('Match reason preview for Elon Musk feed:\n');
  for (const m of matches) {
    if (!m.claim) continue;
    const reason = matchReason('Elon Musk', m.claim.primarySubject, m.claim.mentionedEntities, m.claim.highlight);
    const marker = reason ? `↳ ${reason}` : '(no annotation)';
    console.log(`  ${m.score.toFixed(3)} ew=${m.entityWeight.toFixed(2)}  "${m.claim.highlight.slice(0, 60)}..."`);
    console.log(`        ${marker}\n`);
  }

  await db.$disconnect();
}
main();
