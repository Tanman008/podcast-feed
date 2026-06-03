// Shared OpenAI client with a process-wide concurrency cap.
// ALL OpenAI calls in this codebase must go through openaiCall() so the worker
// cannot self-DDoS the API regardless of how many jobs run in parallel.
//
// Tune OPENAI_MAX_CONCURRENCY in .env: Tier 1 → 8, Tier 2 → 16, Tier 3+ → 24.

import OpenAI from 'openai';
import pLimit from 'p-limit';
import { withRetry, RetryOptions } from '@/lib/utils/retry';

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? 'missing' });

// Single limiter shared across the entire Node process.
const GLOBAL_LIMIT = pLimit(
  parseInt(process.env.OPENAI_MAX_CONCURRENCY || '8', 10)
);

// Route every chat/embedding call through this: global cap + retry.
export function openaiCall<T>(fn: () => Promise<T>, retry?: RetryOptions): Promise<T> {
  return GLOBAL_LIMIT(() => withRetry(fn, retry));
}
