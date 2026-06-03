// lib/utils/retry.ts
// Exponential backoff with jitter for all external API calls.
// Handles rate limits (429) and temporary failures (5xx).
// Honors OpenAI Retry-After / retry-after-ms headers when present.

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

function getRetryAfterMs(error: any): number {
  // OpenAI SDK attaches error.headers as a plain object or Headers instance
  const h = error?.headers ?? error?.response?.headers;
  if (!h) return 0;
  const get = (k: string) => (typeof h.get === 'function' ? h.get(k) : h[k]) ?? null;
  const ms = Number(get('retry-after-ms'));
  if (ms > 0) return ms;
  const secs = Number(get('retry-after'));
  if (secs > 0) return secs * 1000;
  return 0;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 5;   // was 3 — rate limits need more headroom
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs  = options?.maxDelayMs  ?? 60000; // was 30000

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status;
      const isRateLimit   = status === 429;
      const isServerError = typeof status === 'number' && status >= 500;
      const isLastAttempt = attempt === maxAttempts - 1;

      // Never retry non-retriable client errors (4xx other than 429)
      if (!isRateLimit && !isServerError) throw error;
      if (isLastAttempt) throw error;

      // Honor the server's backoff hint; fall back to exponential + jitter
      const retryAfterMs = getRetryAfterMs(error);
      const expo = Math.pow(2, attempt) * baseDelayMs + Math.random() * 500;
      const delayMs = Math.min(Math.max(retryAfterMs, expo), maxDelayMs);

      console.warn(
        `[Retry] attempt ${attempt + 1}/${maxAttempts} (status=${status}); ` +
        `waiting ${Math.round(delayMs)}ms${retryAfterMs > 0 ? ' (server hint)' : ''}...`
      );

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('unreachable');
}
