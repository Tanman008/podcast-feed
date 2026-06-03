// Classifies a search input and expands it into targeted Podcast Index queries.
// Ticker resolution: checks local NASDAQ/NYSE lookup first, then LLM expansion.
// Uses gpt-4o-mini — single call, fast.

import OpenAI from 'openai';
import { withRetry } from '@/lib/utils/retry';
import { lookupTicker } from '@/lib/tickers/lookup';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? 'missing' });

export interface SearchExpansion {
  inputType: 'company' | 'person' | 'theme' | 'product' | 'event';
  entityName: string;      // Normalized display name (e.g. "Badger Meter" not "BDGI")
  queries: string[];       // 3–4 detailed queries for matching episode content
  feedTerms?: string[];    // 2–4 short terms (1–3 words) for Podcast Index feed name search
}

const PROMPT = `You are a financial podcast search assistant. Given a user's search input, return JSON with two types of search terms:

1. "queries": 3-4 detailed investment-relevant phrases describing what episodes should discuss
2. "feedTerms": 2-4 SHORT terms (1-3 words) that match PODCAST NAMES on Podcast Index — think show names, not episode topics

feedTerms strategy by type:
- company: the company name, sector, and category
  "NVIDIA" → feedTerms: ["NVIDIA", "semiconductor", "AI technology"]
- person: their company/org, their domain, and a broad format
  "Satya Nadella" → feedTerms: ["Microsoft", "technology", "business interview"]
  "Jensen Huang" → feedTerms: ["NVIDIA", "semiconductor", "AI"]
- theme: the core 1-2 word theme
  "AI infrastructure" → feedTerms: ["AI", "technology", "venture capital"]
- product: product name and category
  "Cursor AI" → feedTerms: ["Cursor", "developer tools", "AI coding"]

Return ONLY valid JSON — no markdown, no explanation:
{
  "inputType": "company|person|theme|product|event",
  "entityName": "normalized display name",
  "queries": ["detailed query 1", "detailed query 2", "detailed query 3"],
  "feedTerms": ["short term 1", "short term 2", "short term 3"]
}`;

export async function expandSearchTerm(input: string): Promise<SearchExpansion> {
  const trimmed = input.trim();

  // ── Ticker resolution ──────────────────────────────────────────────────────
  // If the input looks like a ticker symbol, resolve to company name before
  // calling the LLM. This prevents small-cap tickers from being mis-identified.
  const tickerMatch = lookupTicker(trimmed);
  const llmInput = tickerMatch
    ? `${tickerMatch} (ticker: ${trimmed.toUpperCase()})`
    : trimmed;

  if (tickerMatch) {
    console.log(`[searchExpander] Ticker resolved: ${trimmed.toUpperCase()} → ${tickerMatch}`);
  }

  try {
    const res = await withRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: llmInput },
        ],
        max_tokens: 300,
        temperature: 0.1,
      })
    );

    const raw = res.choices[0]?.message?.content?.trim() ?? '';
    const parsed = JSON.parse(raw) as SearchExpansion;

    if (!parsed.entityName || !Array.isArray(parsed.queries) || parsed.queries.length === 0) {
      throw new Error('Invalid expansion response');
    }

    return {
      inputType: parsed.inputType ?? 'company',
      entityName: tickerMatch ?? parsed.entityName,
      queries: parsed.queries.slice(0, 4),
      feedTerms: Array.isArray(parsed.feedTerms) ? parsed.feedTerms.slice(0, 4) : [],
    };
  } catch (err) {
    console.warn('[searchExpander] LLM failed, using fallback:', err);
    const fallbackName = tickerMatch ?? trimmed;
    return {
      inputType: 'company',
      entityName: fallbackName,
      queries: [fallbackName],
      feedTerms: [fallbackName],
    };
  }
}
