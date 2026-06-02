// lib/config/optimization.ts
// Configuration for Phase 1 baseline vs Phase 2 optimizations
// Enable features via environment variables (no code changes needed)

export const OPTIMIZATION_CONFIG = {
  // Phase 1: false (all chunks are extracted via LLM)
  // Phase 2: true (pre-computed entity cache, skip LLM for known tickers)
  USE_ENTITY_CACHE: process.env.USE_ENTITY_CACHE === 'true',

  // Phase 1: false (process all chunks)
  // Phase 2: true (skip sponsor reads, ads, etc. via skipPattern)
  SMART_CHUNKING_ENABLED: process.env.SMART_CHUNKING_ENABLED === 'true',

  // Skip pattern for sponsor/filler utterances.
  // Override via CHUNK_SKIP_PATTERN env var. Default filters common ad-read phrases.
  CHUNK_SKIP_PATTERN: process.env.CHUNK_SKIP_PATTERN
    ? new RegExp(process.env.CHUNK_SKIP_PATTERN, 'i')
    : /\bbrought to you by\b|\buse (?:code|promo)\b|\bpromo code\b|\bad break\b|\bsponsor(?:ed)? (?:by|break)\b/i,

  // Phase 1: 'immediate' (novelty scored in Pass 2 during job)
  // Phase 2: 'deferred' (novelty scoring queued for batch processing)
  NOVELTY_SCORING_MODE: (process.env.NOVELTY_SCORING_MODE || 'immediate') as 'immediate' | 'deferred',

  // Phase 1: 'openai' (text-embedding-3-small)
  // Phase 2 options: 'ollama', 'voyage', 'cohere'
  EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER || 'openai',

  // Phase 1: false (ingest all episodes)
  // Phase 2: true (check for duplicate episodes via transcript hash)
  ENABLE_DEDUPLICATION: process.env.ENABLE_DEDUPLICATION === 'true',

  // Number of parallel LLM calls during entity extraction
  // CLAUDE.md: "Never fully serial, never fully parallel" → 8 is optimal
  LLM_CONCURRENCY: parseInt(process.env.LLM_CONCURRENCY || '8', 10),

  CHUNKING: {
    TARGET_WORDS: 250,
    MAX_WORDS: 300,
    OVERLAP_WORDS: 30,
    MIN_WORDS: 20,
  },

  // Novelty scoring parameters
  NOVELTY: {
    PRIOR_CHUNK_LIMIT: 50, // Query 50 most recent chunks per entity
    MIN_PRIOR_CHUNKS: 5, // If fewer prior chunks, score 0.8
    DEFAULT_SCORE_NO_PRIOR: 0.8,
  },

  // Logging
  VERBOSE: process.env.VERBOSE === 'true',
} as const;

export type OptimizationConfig = typeof OPTIMIZATION_CONFIG;

// Log active config on startup (helpful for debugging)
if (OPTIMIZATION_CONFIG.VERBOSE) {
  console.log('[Config] Optimization flags:', {
    USE_ENTITY_CACHE: OPTIMIZATION_CONFIG.USE_ENTITY_CACHE,
    SMART_CHUNKING_ENABLED: OPTIMIZATION_CONFIG.SMART_CHUNKING_ENABLED,
    NOVELTY_SCORING_MODE: OPTIMIZATION_CONFIG.NOVELTY_SCORING_MODE,
    EMBEDDINGS_PROVIDER: OPTIMIZATION_CONFIG.EMBEDDINGS_PROVIDER,
    ENABLE_DEDUPLICATION: OPTIMIZATION_CONFIG.ENABLE_DEDUPLICATION,
    LLM_CONCURRENCY: OPTIMIZATION_CONFIG.LLM_CONCURRENCY,
  });
}
