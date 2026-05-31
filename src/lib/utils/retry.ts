// lib/utils/retry.ts
// Exponential backoff with jitter for all external API calls
// Handles rate limits (429) and temporary failures (5xx)

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 30000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt === maxAttempts - 1;
      const isRateLimit = error?.status === 429;
      const isServerError = error?.status >= 500;

      // Don't retry client errors (except rate limit)
      if (!isRateLimit && !isServerError && attempt > 0) {
        throw error;
      }

      if (isLastAttempt) {
        throw error;
      }

      // Exponential backoff: 2^attempt * baseDelay + jitter
      const exponentialDelay = Math.pow(2, attempt) * baseDelayMs;
      const jitter = Math.random() * 500; // Up to 500ms jitter
      const delayMs = Math.min(exponentialDelay + jitter, maxDelayMs);

      console.warn(
        `[Retry] Attempt ${attempt + 1}/${maxAttempts} failed (${error?.status || error?.message}). ` +
        `Retrying in ${Math.round(delayMs)}ms...`
      );

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('unreachable');
}
