// Classifies a search input and expands it into targeted Podcast Index queries.
// Ticker resolution: checks local NASDAQ/NYSE lookup first, then LLM expansion.
// Uses gpt-4o-mini — single call, fast.

import OpenAI from 'openai';
import { withRetry } from '@/lib/utils/retry';
import { lookupTicker } from '@/lib/tickers/lookup';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface SearchExpansion {
  inputType: 'company' | 'person' | 'theme' | 'product' | 'event';
  entityName: string;  // Normalized display name (e.g. "Badger Meter" not "BDGI")
  queries: string[];   // 3–4 targeted search queries for Podcast Index
}

const PROMPT = `You are a financial podcast search assistant. Given a user's search input, classify it and generate targeted search queries for finding relevant podcast episodes on Podcast Index.

Input types and query strategies:
- company: Focus on earnings, revenue, guidance, competitive position, market share
  Example input: "NVIDIA" → queries: ["NVIDIA earnings revenue guidance", "NVIDIA datacenter GPU demand", "Blackwell H100 competitive moat", "CUDA AI infrastructure pricing"]
- person: Focus on interviews, keynotes, predictions, track record
  Example input: "Jensen Huang" → queries: ["Jensen Huang interview", "Jensen Huang NVIDIA strategy", "Jensen Huang AI keynote"]
- theme: Focus on market dynamics, investment thesis, sector trends
  Example input: "AI infrastructure" → queries: ["AI infrastructure CapEx spending", "GPU data center hyperscaler", "AI training inference supply chain", "AI infrastructure investment thesis"]
- product: Focus on adoption, pricing, competition, roadmap
  Example input: "Cursor AI" → entityName: "Cursor" → queries: ["Cursor AI coding assistant", "AI coding tools developer adoption", "Cursor versus GitHub Copilot"]
- event: Focus on coverage, analysis, implications
  Example input: "WWDC 2025" → queries: ["WWDC 2025 Apple announcements", "Apple developer conference AI features"]

Return ONLY valid JSON — no markdown, no explanation:
{
  "inputType": "company|person|theme|product|event",
  "entityName": "normalized display name",
  "queries": ["query 1", "query 2", "query 3", "query 4"]
}

Generate exactly 3–4 queries. Queries should be 3–6 words each, specific and investment-relevant.`;

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
      // Prefer the resolved company name over whatever the LLM returned for the entityName
      entityName: tickerMatch ?? parsed.entityName,
      queries: parsed.queries.slice(0, 4),
    };
  } catch (err) {
    console.warn('[searchExpander] LLM failed, using fallback:', err);
    // If ticker resolved, still use the company name for the fallback query
    const fallbackName = tickerMatch ?? trimmed;
    return {
      inputType: 'company',
      entityName: fallbackName,
      queries: [fallbackName],
    };
  }
}
