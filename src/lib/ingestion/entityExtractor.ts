// lib/ingestion/entityExtractor.ts
// Combined Claude Haiku call: entities + conviction + speaker guess
// One call per chunk, not three separate calls
// Concurrency: 8 via p-limit (respects rate limits)

import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';
import { withRetry } from '@/lib/utils/retry';
import { OPTIMIZATION_CONFIG } from '@/lib/config/optimization';
import { RawChunk } from './chunker';
import { Entity, EntityType, MentionType } from '@prisma/client';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
  convictionScore: number;
  speakerGuess: string | null;
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
      "ticker": "SYMBOL or null",
      "confidence": 0.0-1.0,
      "mentionType": "direct|implied|contextual"
    }
  ],
  "convictionScore": 0.0-1.0,
  "speakerGuess": "name or null"
}

Rules for entities:
- Include tickers, companies, people, investors, executives, topics, products, sectors, funds
- entityType MUST be one of the 8 listed above
- Include well-known tickers (NVDA, TSLA, AAPL, etc.)
- Confidence < 0.6 should be omitted entirely from the array
- Return [] for entities if none found

Rules for conviction:
- High conviction (0.7–1.0): Declarative claims, quantified positions, explicit directional bets, causal explanations
- Mid conviction (0.3–0.7): Mixed signals, some directional language with hedges
- Low conviction (0.0–0.3): Vague hedging, "might", "could", "not sure", speculative
- Return a single number between 0.0 and 1.0

Rules for speakerGuess:
- ONLY infer from self-reference ("I, Chamath, think...") or direct addressing ("Jensen, what's your view?")
- Do NOT guess randomly
- Return null if unclear or multiple speakers
- Return just the name, no titles

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
  // Phase 2 hook: Entity cache (disabled in Phase 1)
  if (options?.useCache && options?.cachedEntities) {
    // TODO: Phase 2 - check cache first, only call LLM for novel entities
    // For now, fall through to LLM call
  }

  return withRetry(async () => {
    const prompt = ENTITY_EXTRACTION_PROMPT.replace('{transcript}', chunk.cleanedText);

    const message = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

    // Parse JSON response
    let result: EntityExtractionResult;
    try {
      result = JSON.parse(responseText);
    } catch (error) {
      console.error('[EntityExtractor] Failed to parse JSON:', responseText);
      return {
        entities: [],
        convictionScore: 0.5, // neutral default
        speakerGuess: null,
      };
    }

    // Validate and normalize response
    if (!result.entities || !Array.isArray(result.entities)) {
      result.entities = [];
    }

    // Clamp conviction score
    result.convictionScore = Math.max(0, Math.min(1, result.convictionScore ?? 0.5));

    // Filter out low-confidence entities (per spec: < 0.6)
    result.entities = result.entities.filter(e => e.confidence >= 0.6);

    // Normalize entity type to valid enum
    result.entities = result.entities.map(e => ({
      ...e,
      entityType: validateEntityType(e.entityType),
      mentionType: validateMentionType(e.mentionType),
      normalizedName: (e.normalizedName || e.name)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim(),
    }));

    return result;
  }, {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  });
}

// Analyze multiple chunks in parallel with bounded concurrency
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

  const tasks = chunks.map(chunk =>
    limiter(() =>
      analyzeChunk(chunk, {
        useCache: options?.useCache,
        cachedEntities: options?.cachedEntities,
      })
    )
  );

  return Promise.all(tasks);
}

function validateEntityType(type: string): EntityType {
  const valid: EntityType[] = [
    'ticker',
    'company',
    'person',
    'investor',
    'executive',
    'topic',
    'product',
    'sector',
    'fund',
  ];

  if (valid.includes(type as EntityType)) {
    return type as EntityType;
  }

  // Default to 'company' if unknown
  return 'company';
}

function validateMentionType(type: string): MentionType {
  const valid: MentionType[] = ['direct', 'implied', 'contextual'];

  if (valid.includes(type as MentionType)) {
    return type as MentionType;
  }

  return 'direct';
}

// Cost estimation for Phase 2 planning
export function estimateLLMCost(chunkCount: number, avgTokensPerChunk: number = 400): number {
  // Claude Haiku: $0.80 per 1M input tokens, $0.40 per 1M output tokens
  // Estimate: ~500 tokens input per chunk (chunk + prompt), ~200 tokens output
  const inputTokens = chunkCount * (avgTokensPerChunk + 300); // chunk + prompt overhead
  const outputTokens = chunkCount * 200;

  const inputCost = (inputTokens / 1_000_000) * 0.80;
  const outputCost = (outputTokens / 1_000_000) * 0.40;

  return inputCost + outputCost;
}
