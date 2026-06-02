// POST /api/interests/matches/[matchId]/gloss
// Returns or generates a gloss for the Claim associated with this match.
// Gloss is stored on Claim.gloss (shared across all interests that surface it).

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import OpenAI from 'openai';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ matchId: string }> }
) {
  const { matchId } = await params;

  const match = await db.interestMatch.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      claim: { select: { id: true, highlight: true, gloss: true } },
      chunk: { select: { text: true, speakerName: true, speakerLabel: true } },
    },
  });

  if (!match) return NextResponse.json({ error: 'Match not found' }, { status: 404 });

  // Return cached result ('' = tried but no gloss; non-empty = real gloss)
  if (match.claim.gloss !== null) {
    return NextResponse.json({ gloss: match.claim.gloss || null });
  }

  const speaker = match.chunk.speakerName
    ?? (match.chunk.speakerLabel !== null ? `Speaker ${match.chunk.speakerLabel}` : 'Unknown speaker');

  const prompt = `Given this highlight from a financial podcast, write a single sentence (max 15 words) adding context a listener would NOT already know from the highlight itself.

Do NOT: restate the quote, explain its implication (the claim already does that), or make generic statements.
DO: name what narrative or position it contradicts, which ongoing debate it enters, or what prior assumption it challenges.

FORBIDDEN STARTING PHRASES — do not begin your response with any of these:
- "Challenges the narrative"
- "Signals a shift"
- "Highlights the importance"
- "Suggests that"
- "Indicates"
- "Reflects"

Vary sentence structure. Start with a verb, a specific entity, or a comparison. Example openings:
- "Echoes Burry's recent..."
- "NVDA bull case relies on..."
- "First time anyone has named..."
- "Counter to MSFT Q3 guidance..."
- "Aligned with Druckenmiller's..."
- "Contradicts the consensus..."

If you cannot produce a gloss that adds genuine external context not visible in the highlight itself, return the word null.

Highlight: ${match.claim.highlight}
Surrounding context: ${match.chunk.text}
Speaker: ${speaker}

Return only the gloss sentence, or the word null.`;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 60,
    temperature: 0.3,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  const gloss = (!raw || raw.toLowerCase() === 'null') ? '' : raw;

  await db.claim.update({ where: { id: match.claim.id }, data: { gloss } });

  return NextResponse.json({ gloss: gloss || null });
}
