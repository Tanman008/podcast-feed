// lib/scoring/conviction.ts
// Conviction scoring reference and utilities
// Note: Conviction is scored in entityExtractor.ts as part of combined LLM call
// This file exports the prompt template and parsing logic for reference/testing

export const CONVICTION_PROMPT_TEMPLATE = `You are a financial analyst evaluating speaker conviction in a transcript excerpt.

Score the following excerpt on conviction from 0.0 to 1.0.

Conviction means: the speaker expresses clear, confident, directional views.

High conviction (0.7–1.0):
- Declarative claims ("I believe...", "It's clear that...")
- Quantified positions ("We'll see 30% growth")
- Explicit directional bets ("We're betting on AI")
- Repeated emphasis or causal explanations
- Explicit risk acknowledgment ("The risk is...")

Mid conviction (0.3–0.7):
- Mixed signals with some directional language
- Hedged claims ("I think it's likely that...")
- Some quantification mixed with uncertainty

Low conviction (0.0–0.3):
- Vague hedging ("might", "could", "not sure")
- Speculative musings ("It's possible that...")
- Non-committal language
- Multiple qualifications and disclaimers

Return ONLY a JSON object: {"conviction": 0.0}
No explanation. No other text.

Excerpt:
"""
{excerpt}
"""`;

export function parseConvictionResponse(response: string): number {
  try {
    const parsed = JSON.parse(response);
    const score = parseFloat(parsed.conviction);

    if (isNaN(score)) {
      console.warn('[Conviction] Invalid score in response:', response);
      return 0.5; // neutral default
    }

    // Clamp to [0.0, 1.0]
    return Math.max(0, Math.min(1, score));
  } catch (error) {
    console.warn('[Conviction] Failed to parse conviction response:', response, error);
    return 0.5; // neutral default
  }
}

// Calculate conviction percentile for display purposes
export function convictionPercentile(score: number): 'low' | 'medium' | 'high' {
  if (score < 0.3) return 'low';
  if (score < 0.7) return 'medium';
  return 'high';
}
