// lib/scoring/speakerAuthority.ts
// Assesses a speaker's domain authority in tech/finance using GPT-4o-mini.
// Results are cached in Speaker.metadataJson so each name is assessed only once.
// Returns 0–1: CEO/founder ≈ 0.9, fund manager ≈ 0.8, analyst ≈ 0.65, host ≈ 0.45, unknown ≈ 0.5

import { db } from '@/lib/db';
import { openai, openaiCall } from '@/lib/openai/client';

interface AuthorityCache {
  authorityScore: number;
  role: string;
  assessedAt: string;
}

export async function getOrAssessSpeakerAuthority(name: string): Promise<number> {
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (!normalizedName) return 0.5;

  // Check cache in Speaker table
  const existing = await db.speaker.findUnique({
    where: { normalizedName },
    select: { metadataJson: true },
  });

  if (existing?.metadataJson) {
    const cached = existing.metadataJson as unknown as AuthorityCache;
    if (typeof cached.authorityScore === 'number') return cached.authorityScore;
  }

  // Cache miss — assess via GPT-4o-mini
  const authorityScore = await assessAuthority(name);

  // Upsert Speaker record with the assessment cached
  await db.speaker.upsert({
    where: { normalizedName },
    update: {
      metadataJson: {
        authorityScore,
        role: 'assessed',
        assessedAt: new Date().toISOString(),
      } satisfies AuthorityCache,
    },
    create: {
      name,
      normalizedName,
      metadataJson: {
        authorityScore,
        role: 'assessed',
        assessedAt: new Date().toISOString(),
      } satisfies AuthorityCache,
    },
  });

  return authorityScore;
}

async function assessAuthority(name: string): Promise<number> {
  try {
    const response = await openaiCall(() => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `You are assessing how authoritative a speaker is in the context of technology and financial markets.

Speaker name: "${name}"

Based on their known professional role, return ONLY a JSON object:
{
  "role": "brief description of their role (e.g. CEO of NVIDIA, venture capitalist, podcast host, financial analyst)",
  "authorityScore": 0.0-1.0
}

Scoring guide:
- 0.85–1.0: CEO/founder/CTO of major public tech or finance company (e.g. Jensen Huang, Elon Musk, Jamie Dimon)
- 0.70–0.85: Senior fund manager, general partner at top-tier VC, CFO of major company
- 0.55–0.70: Analyst, portfolio manager, senior executive below C-suite, respected independent investor
- 0.40–0.55: Podcast host, journalist, commentator, or moderately known investor
- 0.30–0.40: Unknown person or unclear relevance to tech/finance
- 0.5: If you genuinely cannot determine who this person is

Return only the JSON.`,
        },
      ],
      max_tokens: 100,
      temperature: 0,
    }));

    const text = (response.choices[0]?.message?.content ?? '{}').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');

    const parsed = JSON.parse(text);
    const score = parseFloat(parsed.authorityScore);
    return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
  } catch {
    return 0.5; // neutral fallback — never block ingestion
  }
}
