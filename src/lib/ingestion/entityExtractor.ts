// lib/ingestion/entityExtractor.ts
// Combined GPT-4o-mini call per chunk: entities + conviction score + key quote.
// Speaker attribution is now handled by Deepgram diarization — speakerGuess removed.
// Concurrency: 8 via p-limit (respects rate limits).

import OpenAI from 'openai';
import pLimit from 'p-limit';
import { withRetry } from '@/lib/utils/retry';
import { OPTIMIZATION_CONFIG } from '@/lib/config/optimization';
import { RawChunk } from './chunker';
import { EntityType, MentionType } from '@prisma/client';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const KNOWN_TICKERS: Record<string, string> = {
  'nvidia': 'NVDA',
  'apple': 'AAPL',
  'microsoft': 'MSFT',
  'google': 'GOOGL',
  'alphabet': 'GOOGL',
  'amazon': 'AMZN',
  'meta': 'META',
  'facebook': 'META',
  'tesla': 'TSLA',
  'netflix': 'NFLX',
  'amd': 'AMD',
  'intel': 'INTC',
  'qualcomm': 'QCOM',
  'broadcom': 'AVGO',
  'tsmc': 'TSM',
  'samsung': '005930.KS',
  'salesforce': 'CRM',
  'oracle': 'ORCL',
  'ibm': 'IBM',
  'uber': 'UBER',
  'lyft': 'LYFT',
  'airbnb': 'ABNB',
  'spotify': 'SPOT',
  'shopify': 'SHOP',
  'palantir': 'PLTR',
  'snowflake': 'SNOW',
  'crowdstrike': 'CRWD',
  'datadog': 'DDOG',
  'cloudflare': 'NET',
  'coinbase': 'COIN',
  'berkshire hathaway': 'BRK.B',
  'jpmorgan': 'JPM',
  'goldman sachs': 'GS',
  'morgan stanley': 'MS',
};

export interface ExtractedEntity {
  name: string;
  normalizedName: string;
  entityType: EntityType;
  ticker?: string;
  confidence: number;
  mentionType: MentionType;
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  claimSpecificityScore: number; // replaces convictionScore — measures how specific/actionable the claim is
  forwardLookingScore: number;   // 0=pure history, 1=explicit future projection
  keyQuote: string | null;
  keyPhrase: string | null;
}

const ENTITY_EXTRACTION_PROMPT = `You are a financial analyst extracting entities from podcast transcripts.

Analyze this transcript excerpt and extract all financial entities mentioned.

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "entities": [
    {
      "name": "display name",
      "normalizedName": "lowercase, no special chars",
      "entityType": "ticker|company|person|investor|executive|topic|product|sector|fund",
      "ticker": "EXCHANGE_SYMBOL or null",
      "confidence": 0.0-1.0,
      "mentionType": "direct|implied|contextual"
    }
  ],
  "claimSpecificityScore": 0.0-1.0,
  "forwardLookingScore": 0.0-1.0,
  "keyQuote": "Select the single most investable sentence from this transcript chunk. Rank in this priority order: (1) forward-looking quantified claims — 'we expect', 'we're guiding to', 'by Q3 we will'; (2) explicit position statements — 'we're long', 'I'm buying', 'I'd short'; (3) novel factual claims with specific numbers; (4) strong directional opinions with reasoning; (5) historical facts with numbers (lowest priority). Return null if no sentence clears a minimum bar of specificity. Copy verbatim.",
  "temporality": "forward|current|historical",
  "specificity": 0.0-1.0,
  "forwardWeight": 0.0-1.0,
  "keyPhrase": "the 2–5 word fragment inside keyQuote carrying the sharpest signal — a specific number, a directional bet, or a concrete claim. Good examples: 'margins expanding 400bps', 'buying aggressively here', 'guidance cut 15%', '$300M this year'. Bad examples: the interest term itself (e.g. 'OpenAI', 'NVDA'), generic phrases like 'said that' or 'I think'. Return null if none exists."
}

Rules for entities:
- Include tickers, companies, people, investors, executives, topics, products, sectors, funds
- entityType MUST be one of the 9 listed above
- CRITICAL: For any publicly traded company, you MUST set ticker to the primary US stock symbol. Examples: Google/Alphabet → GOOGL, NVIDIA → NVDA, Apple → AAPL, Microsoft → MSFT, Meta → META, Amazon → AMZN, Tesla → TSLA, Netflix → NFLX. Never leave ticker null for a well-known public company.
- Confidence < 0.6 should be omitted entirely from the array
- Return [] for entities if none found

Rules for claimSpecificityScore:
- 1.0: Contains specific numbers, dollar amounts, percentages, explicit ticker positions, or named timeframes (e.g. "Q3 2025", "next 18 months") AND a clear directional claim (buying, shorting, raising guidance, cutting estimates)
- 0.7–0.9: Specific claim with at least one concrete data point or named position, even if direction is implied
- 0.4–0.6: Some specificity — references named companies or people making a directional statement, but no hard numbers
- 0.1–0.3: General commentary, observations, or hedged speculation with no actionable anchor
- 0.0: Pure filler, transitions, or content with zero investment signal

Rules for forwardLookingScore (temporal orientation — investors care about the future, not history):
- 1.0: Explicit future projection or plan ("we plan to", "by next year", "we expect", "going forward", "in Q3 2025", "we're going to")
- 0.7–0.9: Present-tense observations about current state or momentum ("we're seeing", "currently", "right now", "this is happening")
- 0.4–0.6: Mix of present context and historical reference to explain current situation
- 0.1–0.3: Primarily historical ("last year", "back in 2020", "we did", "previously", "at the time")
- 0.0: Pure historical fact or biographical information with no present/future relevance ("was founded in", "in 1993 Jensen", "the company started")

Rules for keyQuote:
- A number alone is NOT signal. The quantifier must be attached to a claim about cause, effect, structure, or direction.
- Return null (do NOT select) for:
  - Bare quantifiers with no claim: "we have to put in $4B" — states a cost with no outcome
  - Sentences where the quantifier is in a subordinate clause unrelated to the main point
  - Entity mentions with no claim: "it was specifically OpenAI", "and OpenAI too" — name present, nothing said about it
- Accept only if the sentence answers at least one of:
  - WHAT will happen / has happened (specific outcome)
  - WHY it matters (causal claim)
  - HOW MUCH and AT WHAT (number attached to a structural claim)
  - WHO is doing WHAT with HOW MUCH

Good keyQuotes — select these:
- "If OpenAI and Anthropic are at $100B of ARR with 80% gross margins on inference, the returns are there"
- "We're seeing margins expand 400bps next quarter driven by pricing power on inference"
- "I'm buying NVDA aggressively here because the deployment cycle has another 18 months"
- "The 17.5% preferred guaranteed return is the new floor for compute infrastructure deals"

Bad keyQuotes — return null or pick a different sentence:
- "So, you know, you have to put in $4,000,000,000" (number, no claim)
- "It was specifically OpenAI" (entity mention, no claim)
- "Anthropic is awesome" (opinion, no specificity)
- "We're gonna start to see end user achievements" (vague future)

Transcript:
"""
{transcript}
"""`;

export async function analyzeChunk(
  chunk: RawChunk,
  options?: {
    useCache?: boolean;
    cachedEntities?: Map<string, ExtractedEntity>;
  }
): Promise<EntityExtractionResult> {
  if (options?.useCache && options?.cachedEntities) {
    // Phase 2 hook: entity cache
  }

  return withRetry(async () => {
    const prompt = ENTITY_EXTRACTION_PROMPT.replace('{transcript}', chunk.text || chunk.cleanedText);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
      temperature: 0,
    });

    const responseText = response.choices[0]?.message?.content ?? '';

    let result: EntityExtractionResult;
    try {
      const cleaned = responseText
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
      result = JSON.parse(cleaned);
    } catch {
      console.error('[EntityExtractor] Failed to parse JSON response:', responseText);
      return { entities: [], claimSpecificityScore: 0.3, forwardLookingScore: 0.5, keyQuote: null, keyPhrase: null };
    }

    if (!result.entities || !Array.isArray(result.entities)) {
      result.entities = [];
    }

    result.claimSpecificityScore = Math.max(0, Math.min(1, (result as any).claimSpecificityScore ?? 0.3));
    result.forwardLookingScore = Math.max(0, Math.min(1, (result as any).forwardLookingScore ?? 0.5));
    result.keyQuote = typeof result.keyQuote === 'string' && result.keyQuote.trim() ? result.keyQuote.trim() : null;
    result.keyPhrase = typeof result.keyPhrase === 'string' && result.keyPhrase.trim() ? result.keyPhrase.trim() : null;

    result.entities = result.entities
      .filter(e => e.confidence >= 0.6)
      .map(e => {
        const normalizedName = (e.normalizedName || e.name)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .trim();
        const ticker = e.ticker || KNOWN_TICKERS[normalizedName] || undefined;
        return {
          ...e,
          entityType: validateEntityType(e.entityType),
          mentionType: validateMentionType(e.mentionType),
          normalizedName,
          ticker,
        };
      });

    return result;
  }, { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000 });
}

export async function analyzeChunksBatch(
  chunks: RawChunk[],
  options?: {
    concurrency?: number;
    useCache?: boolean;
    cachedEntities?: Map<string, ExtractedEntity>;
  }
): Promise<EntityExtractionResult[]> {
  const concurrency = options?.concurrency ?? OPTIMIZATION_CONFIG.LLM_CONCURRENCY;
  const limiter = pLimit(concurrency);

  return Promise.all(
    chunks.map(chunk =>
      limiter(() => analyzeChunk(chunk, {
        useCache: options?.useCache,
        cachedEntities: options?.cachedEntities,
      }))
    )
  );
}

function validateEntityType(type: string): EntityType {
  const valid: EntityType[] = ['ticker', 'company', 'person', 'investor', 'executive', 'topic', 'product', 'sector', 'fund'];
  return valid.includes(type as EntityType) ? (type as EntityType) : 'company';
}

function validateMentionType(type: string): MentionType {
  const valid: MentionType[] = ['direct', 'implied', 'contextual'];
  return valid.includes(type as MentionType) ? (type as MentionType) : 'direct';
}

// Cost estimation helper
export function estimateLLMCost(chunkCount: number, avgTokensPerChunk: number = 400): number {
  // GPT-4o-mini: $0.15/1M input, $0.60/1M output
  const inputTokens = chunkCount * (avgTokensPerChunk + 300);
  const outputTokens = chunkCount * 200;
  return (inputTokens / 1_000_000) * 0.15 + (outputTokens / 1_000_000) * 0.60;
}
