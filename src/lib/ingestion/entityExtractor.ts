// lib/ingestion/entityExtractor.ts
// Combined GPT-4o-mini call per chunk: entities + conviction score + key quote.
// Speaker attribution is now handled by Deepgram diarization — speakerGuess removed.
// Concurrency: 8 via p-limit (respects rate limits).

import pLimit from 'p-limit';
import { OPTIMIZATION_CONFIG } from '@/lib/config/optimization';
import { RawChunk } from './chunker';
import { EntityType, MentionType } from '@prisma/client';
import { openai, openaiCall } from '@/lib/openai/client';

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

export interface ExtractedClaim {
  highlight: string;
  context?: string | null;
  startSentenceIndex: number;
  endSentenceIndex: number;
  primarySubject?: string;
  mentionedEntities: string[];
  claimType: string;
  specificity: number;
  completeness: number;
  gloss?: string | null;
  numbers: string[];
  horizon?: string | null;      // retrospective | forward | timeless
  speakerRole?: string | null;  // insider | investor | analyst | host | other
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  claimSpecificityScore: number;
  forwardLookingScore: number;
  keyQuote: string | null;
  keyPhrase: string | null;
  claims: ExtractedClaim[];
}

const ENTITY_EXTRACTION_PROMPT = `You are a financial analyst analyzing a podcast transcript chunk. Do both tasks in one pass.

Return ONLY a valid JSON object (no markdown):
{
  "entities": [{"name":"...","normalizedName":"lowercase no special chars","entityType":"ticker|company|person|investor|executive|topic|product|sector|fund","ticker":"SYMBOL or null","confidence":0.0-1.0,"mentionType":"direct|implied|contextual"}],
  "claimSpecificityScore": 0.0-1.0,
  "forwardLookingScore": 0.0-1.0,
  "keyQuote": "most investable verbatim sentence, or null",
  "keyPhrase": "2-5 word signal fragment from keyQuote, or null",
  "chunkType": "ARGUMENT|POSITION|DATA|THESIS|OPINION|CHITCHAT",
  "claims": [{"highlight":"verbatim text","startSentenceIndex":0,"endSentenceIndex":0,"primarySubject":"entity this is about","mentionedEntities":["other entities"],"claimType":"unit_economics|transaction|growth|thesis|position|competitive|valuation|guidance","specificity":0.0-1.0,"completeness":0.4-1.0,"gloss":null,"numbers":["verbatim quantified facts"]}]
}

ENTITIES: Include all tickers/companies/people/investors/executives/topics/products/sectors/funds with confidence ≥ 0.6. Always set ticker for public companies (NVDA, AAPL, MSFT, GOOGL, META, AMZN, TSLA etc).

SCORES:
- claimSpecificityScore: 1.0=specific numbers+directional claim, 0.7-0.9=one concrete data point, 0.4-0.6=named companies+direction no numbers, 0.1-0.3=general commentary, 0.0=filler
- forwardLookingScore: 1.0=explicit future projection, 0.7-0.9=current state/momentum, 0.4-0.6=mixed, 0.1-0.3=primarily historical, 0.0=pure history

KEYQUOTE: Best single verbatim sentence. Priority: (1) forward-looking quantified claims (2) explicit positions (3) novel facts with numbers (4) strong directional opinions. Return null if no sentence clears a specificity bar. A number alone is NOT signal — the quantifier must attach to a claim about cause/effect/direction.

CLAIMS — two tracks:
SIGNAL (unit_economics|transaction|growth|guidance|valuation): Factual evidence-backed assertions. Always include 2-3 verbatim sentences — the claim + its supporting context. completeness=0.5-0.7 for 1 sentence, 0.7-1.0 for 2-3 sentences. specificity=how precise/measurable.
IDEAS (thesis|competitive|position): Directional beliefs. Minimum 2 verbatim sentences — the core idea + the reasoning or evidence behind it. completeness=0.5 for 2 sentences, 0.7+ with full reasoning chain. specificity=how falsifiable/specific (NOT whether it has numbers).
Return claims:[] for pure filler, intros, ad reads, or zero-substance chunks. VERBATIM ONLY — never paraphrase.

Transcript:
"""
{transcript}
"""`;

export async function analyzeChunk(
  chunk: RawChunk,
  options?: {
    useCache?: boolean;
    cachedEntities?: Map<string, ExtractedEntity>;
    langSuffix?: string;
  }
): Promise<EntityExtractionResult> {
  if (options?.useCache && options?.cachedEntities) {
    // Phase 2 hook: entity cache
  }

  return openaiCall(async () => {
    const prompt = ENTITY_EXTRACTION_PROMPT.replace('{transcript}', chunk.text || chunk.cleanedText)
      + (options?.langSuffix ?? '');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
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
      return { entities: [], claimSpecificityScore: 0.3, forwardLookingScore: 0.5, keyQuote: null, keyPhrase: null, claims: [] };
    }

    if (!result.entities || !Array.isArray(result.entities)) {
      result.entities = [];
    }

    result.claimSpecificityScore = Math.max(0, Math.min(1, (result as any).claimSpecificityScore ?? 0.3));
    result.forwardLookingScore = Math.max(0, Math.min(1, (result as any).forwardLookingScore ?? 0.5));
    result.keyQuote = typeof result.keyQuote === 'string' && result.keyQuote.trim() ? result.keyQuote.trim() : null;
    result.keyPhrase = typeof result.keyPhrase === 'string' && result.keyPhrase.trim() ? result.keyPhrase.trim() : null;

    result.claims = Array.isArray((result as any).claims)
      ? (result as any).claims
          .filter((c: any) => c.completeness >= 0.5 && typeof c.highlight === 'string' && typeof c.claimType === 'string')
          .map((c: any): ExtractedClaim => ({
            highlight:            c.highlight,
            startSentenceIndex:   c.startSentenceIndex  ?? 0,
            endSentenceIndex:     c.endSentenceIndex    ?? 0,
            primarySubject:       c.primarySubject      ?? undefined,
            mentionedEntities:    Array.isArray(c.mentionedEntities) ? c.mentionedEntities : [],
            claimType:            c.claimType,
            specificity:          Math.max(0, Math.min(1, c.specificity ?? 0.5)),
            completeness:         Math.max(0, Math.min(1, c.completeness ?? 0.5)),
            gloss:                (!c.gloss || c.gloss.toLowerCase() === 'null') ? null : c.gloss,
            numbers:              Array.isArray(c.numbers) ? c.numbers.filter((n: any) => typeof n === 'string') : [],
          }))
      : [];

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

export async function detectLanguage(text: string): Promise<string> {
  try {
    const res = await openaiCall(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: `What language is this text? Reply with ONLY the language name in English (e.g. "English", "German", "Spanish", "Mandarin").\n\n"${text.slice(0, 300)}"` }],
        max_tokens: 5,
        temperature: 0,
      })
    );
    return res.choices[0]?.message?.content?.trim() ?? 'English';
  } catch {
    return 'English';
  }
}

const TRANSLATION_SUFFIX = (lang: string) => `

LANGUAGE: This transcript is in ${lang}. All output fields (highlight, keyQuote, keyPhrase, primarySubject, mentionedEntities, gloss, numbers) MUST be written in English. Translate highlights to natural, accurate English — the VERBATIM rule does not apply to non-English source text. Preserve all numbers and proper nouns exactly.`;

export async function analyzeChunksBatch(
  chunks: RawChunk[],
  options?: {
    concurrency?: number;
    useCache?: boolean;
    cachedEntities?: Map<string, ExtractedEntity>;
    sourceLanguage?: string;
  }
): Promise<EntityExtractionResult[]> {
  const concurrency = options?.concurrency ?? OPTIMIZATION_CONFIG.LLM_CONCURRENCY;
  const limiter = pLimit(concurrency);
  const langSuffix = options?.sourceLanguage && options.sourceLanguage.toLowerCase() !== 'english'
    ? TRANSLATION_SUFFIX(options.sourceLanguage)
    : '';

  return Promise.all(
    chunks.map(chunk =>
      limiter(() => analyzeChunk(chunk, {
        useCache: options?.useCache,
        cachedEntities: options?.cachedEntities,
        langSuffix,
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
