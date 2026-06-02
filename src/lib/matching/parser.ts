// Parse a raw interest term into individual tokens and detect boolean operators.
// Supports: "nvidia", "elon musk AND government", "oil prices AND CPI"
// Returns tokens for vector embedding and a tsquery for full-text search.

export interface ParsedTerm {
  raw: string;
  tokens: string[];        // Individual terms for embedding (joined as one query)
  tsquery: string;         // PostgreSQL tsquery expression
  embeddingText: string;   // Full phrase to embed for semantic search
}

export function parseTerm(raw: string): ParsedTerm {
  // Split on AND (case-insensitive), trim each part
  const parts = raw
    .split(/\s+AND\s+/i)
    .map(p => p.trim())
    .filter(Boolean);

  // Build tsquery: each part becomes a phrase, joined with &&
  // Multi-word parts use <-> (phrase proximity operator)
  const tsquery = parts
    .map(part => {
      const words = part
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(Boolean);
      return words.length > 1
        ? words.join(' <-> ')   // phrase proximity
        : words[0] ?? '';
    })
    .filter(Boolean)
    .join(' & ');

  return {
    raw,
    tokens: parts,
    tsquery,
    embeddingText: parts.join(' '),
  };
}
