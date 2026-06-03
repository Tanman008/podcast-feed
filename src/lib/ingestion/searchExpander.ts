// Classifies a search input and expands it into targeted Podcast Index queries.
// Ticker resolution: checks local NASDAQ/NYSE lookup first, then LLM expansion.
// Uses gpt-4o-mini — single call, fast.

import { lookupTicker } from '@/lib/tickers/lookup';
import { openai, openaiCall } from '@/lib/openai/client';

export interface SearchExpansion {
  inputType: 'company' | 'person' | 'theme' | 'product' | 'event';
  entityName: string;        // Normalized display name (e.g. "Microsoft" not "MSFT")
  queries: string[];         // 3–4 detailed queries for matching episode content
  feedTerms?: string[];      // 2–4 short terms for Podcast Index feed name search
  relatedPeople?: string[];  // C-suite / key executives for company-type inputs
}

const PROMPT = `You are a financial podcast search assistant. Given a user's search input, return JSON with structured search context.

Fields:
1. "queries": 3-4 detailed investment-relevant phrases describing what episodes should discuss
2. "feedTerms": 2-4 SHORT terms (1-3 words) matching PODCAST NAMES on Podcast Index
3. "relatedPeople": for company inputs only — the CEO and up to 3 other key C-suite executives
   whose podcast appearances are most investor-relevant (CFO for financial guidance, CTO for
   product roadmap, President/COO for strategy). Use full names. Empty array for non-company types.

feedTerms strategy:
- company: company name, sector → "NVIDIA" → ["NVIDIA", "semiconductor", "AI technology"]
- person: their org and domain → "Jensen Huang" → ["NVIDIA", "semiconductor", "AI"]
- theme: core 1-2 word theme → "AI infrastructure" → ["AI", "technology", "venture capital"]

relatedPeople examples:
- "Microsoft" → ["Satya Nadella", "Amy Hood", "Brad Smith", "Kevin Scott"]
- "NVIDIA" → ["Jensen Huang", "Colette Kress"]
- "Apple" → ["Tim Cook", "Luca Maestri", "Craig Federighi"]
- Non-company → []

Return ONLY valid JSON — no markdown, no explanation:
{
  "inputType": "company|person|theme|product|event",
  "entityName": "normalized display name",
  "queries": ["query 1", "query 2", "query 3"],
  "feedTerms": ["term 1", "term 2", "term 3"],
  "relatedPeople": ["Full Name 1", "Full Name 2"]
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
    const res = await openaiCall(() =>
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
      inputType:     parsed.inputType ?? 'company',
      entityName:    tickerMatch ?? parsed.entityName,
      queries:       parsed.queries.slice(0, 4),
      feedTerms:     Array.isArray(parsed.feedTerms)     ? parsed.feedTerms.slice(0, 4)     : [],
      relatedPeople: Array.isArray(parsed.relatedPeople) ? parsed.relatedPeople.slice(0, 4) : [],
    };
  } catch (err) {
    console.warn('[searchExpander] LLM failed, using fallback:', err);
    const fallbackName = tickerMatch ?? trimmed;
    return {
      inputType: 'company',
      entityName: fallbackName,
      queries: [fallbackName],
      feedTerms: [fallbackName],
      relatedPeople: [],
    };
  }
}
