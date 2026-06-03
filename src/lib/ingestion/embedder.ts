// lib/ingestion/embedder.ts
// Batch embedding of transcript chunks via OpenAI
// All chunks from one episode in a single API call (array input)
// Supports provider abstraction for Phase 2 (Ollama, Voyage, etc.)

import { OPTIMIZATION_CONFIG } from '@/lib/config/optimization';
import { RawChunk } from './chunker';
import { openai, openaiCall } from '@/lib/openai/client';

export interface EmbeddingResult {
  chunkIndex: number;
  embedding: number[];
}

// Batch embed all chunks from an episode in a single OpenAI call
// Returns array of 1536-dimensional vectors
export async function embedChunks(
  chunks: RawChunk[],
  options?: {
    provider?: string;
  }
): Promise<number[][]> {
  const provider = options?.provider ?? OPTIMIZATION_CONFIG.EMBEDDINGS_PROVIDER;

  if (provider === 'openai') {
    return embedChunksOpenAI(chunks);
  }

  // Phase 2 hooks for other providers
  if (provider === 'ollama') {
    throw new Error('Ollama provider not implemented in Phase 1');
  }

  if (provider === 'voyage') {
    throw new Error('Voyage provider not implemented in Phase 1');
  }

  throw new Error(`Unknown embeddings provider: ${provider}`);
}

async function embedChunksOpenAI(chunks: RawChunk[]): Promise<number[][]> {
  if (chunks.length === 0) {
    return [];
  }

  return openaiCall(async () => {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: chunks.map(c => c.cleanedText),
      dimensions: 1536,
    });

    // Validate response
    if (!response.data || response.data.length !== chunks.length) {
      throw new Error(
        `OpenAI embedding response mismatch: expected ${chunks.length} embeddings, ` +
        `got ${response.data?.length ?? 0}`
      );
    }

    // OpenAI returns embeddings in order matching input
    return response.data.map((item, index) => {
      if (!item.embedding || item.embedding.length !== 1536) {
        throw new Error(
          `Invalid embedding at index ${index}: ` +
          `expected 1536 dimensions, got ${item.embedding?.length ?? 0}`
        );
      }
      return item.embedding;
    });
  }, {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  });
}

// Get embedding for a single chunk (used in Pass 2 novelty scoring if needed)
export async function embedChunk(chunk: RawChunk, provider?: string): Promise<number[]> {
  const embeddings = await embedChunks([chunk], { provider });
  return embeddings[0];
}

// Cost estimation for Phase 2 planning
export function estimateEmbeddingCost(chunkCount: number, avgTokensPerChunk: number = 400): number {
  // text-embedding-3-small: $0.02 per 1M tokens
  const totalTokens = chunkCount * avgTokensPerChunk;
  const costPer1MTokens = 0.02;
  return (totalTokens / 1_000_000) * costPer1MTokens;
}
