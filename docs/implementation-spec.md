# implementation-spec.md
# Podcast Intelligence Platform — Implementation Spec
## (Supplement to roadmap.md + schema.md)

This document fills the gaps left by roadmap.md and schema.md.
It is written specifically for Claude Code to execute Phase 1 without ambiguity.

---

## Decision Log

Every decision below was made explicitly to resolve ambiguity in the original docs.
See the bottom of this file for a full comparison of ChatGPT's implicit decisions vs. the
decisions made here.

---

## 1. Environment Variables

Create a `.env.local` file at the project root with the following variables.
Also commit a `.env.example` with placeholder values and no secrets.

```
# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/podcast_intel"

# OpenAI (embeddings + conviction scoring)
OPENAI_API_KEY="sk-..."

# App
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NODE_ENV="development"
```

**Not needed for Phase 1** (add later):
```
# YouTube Data API (only if switching away from youtube-transcript npm package)
YOUTUBE_API_KEY="..."

# Supabase (when moving off local Postgres)
SUPABASE_URL="..."
SUPABASE_SERVICE_ROLE_KEY="..."
```

---

## 2. YouTube Ingestion Library

**Decision: Use the `youtube-transcript` npm package.**

Rationale:
- Financial podcasts on YouTube almost universally have auto-generated or manual captions
- No audio download required — dramatically simpler MVP
- No Whisper/STT pipeline needed in Phase 1
- Can be called directly from a Next.js API route or background worker
- Falls back gracefully if captions are unavailable (return error, skip episode)

**Do NOT use in Phase 1:**
- `yt-dlp` + Whisper (too complex, requires Python subprocess or separate service)
- YouTube Data API v3 (adds OAuth complexity; captions endpoint is restricted)

**Installation:**
```bash
npm install youtube-transcript
```

**Usage pattern:**
```typescript
import { YoutubeTranscript } from 'youtube-transcript';

const transcript = await YoutubeTranscript.fetchTranscript(videoId);
// Returns: Array<{ text: string, offset: number, duration: number }>
// offset and duration are in milliseconds
```

**Convert to seconds on ingest:**
```typescript
startTimeSeconds = item.offset / 1000
endTimeSeconds = (item.offset + item.duration) / 1000
```

---

## 3. Embedding Model

**Decision: Use `text-embedding-3-small` from OpenAI.**

Rationale:
- 1536 dimensions — reasonable balance of quality vs. storage
- Significantly cheaper than `text-embedding-3-large` (5x cost difference)
- Quality is sufficient for semantic retrieval of financial text at MVP scale
- Upgrade path to `text-embedding-3-large` (3072 dims) is straightforward if retrieval quality demands it

**Prisma schema implication:**
```prisma
embedding Unsupported("vector(1536)")?
```

**pgvector index:**
```sql
CREATE INDEX ON "TranscriptChunk" USING hnsw (embedding vector_cosine_ops);
```

**OpenAI call pattern:**
```typescript
import OpenAI from 'openai';
const openai = new OpenAI();

const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: chunk.cleanedText,
});
const embedding = response.data[0].embedding; // number[], length 1536
```

---

## 4. Chunking Algorithm

**Decision: Sliding window over youtube-transcript segments, split at sentence boundaries.**

The `youtube-transcript` package returns small caption segments (typically 5–15 words each
with timestamps). These must be assembled into meaningful chunks.

### Algorithm (implement in `lib/ingestion/chunker.ts`)

```
TARGET_TOKENS = 400
MAX_TOKENS    = 600
OVERLAP_TOKENS = 80
```

**Step-by-step:**

1. Receive raw transcript segments: `Array<{ text, startTimeSeconds, endTimeSeconds }>`
2. Concatenate segments greedily until token count reaches TARGET_TOKENS
3. At TARGET_TOKENS, scan backward to the nearest sentence-ending punctuation (`.`, `?`, `!`)
4. Split there. Record `startTimeSeconds` of first segment and `endTimeSeconds` of last segment in window
5. Begin next chunk overlapping the last `OVERLAP_TOKENS` tokens of the previous chunk
6. If no sentence boundary found before MAX_TOKENS, force-split at MAX_TOKENS

**Token counting:** Use `GPT-4` tokenizer via `tiktoken` npm package.

```bash
npm install js-tiktoken
```

```typescript
import { encodingForModel } from 'js-tiktoken';
const enc = encodingForModel('gpt-4');
const tokenCount = enc.encode(text).length;
```

**Minimum chunk size:** Discard any chunk with fewer than 50 tokens (usually trailing fragments).

**Output per chunk:**
```typescript
{
  text: string,           // raw joined text
  cleanedText: string,    // lowercased, whitespace-normalized
  startTimeSeconds: number,
  endTimeSeconds: number,
  tokenCount: number,
  chunkIndex: number,     // sequential within episode
}
```

---

## 5. Novelty Scoring — v1 Algorithm

**Decision: Cosine distance from recent same-entity chunks.**

This is the simplest implementable version. It will be wrong often. That is acceptable for MVP.
The goal is a sortable signal, not ground truth.

### Algorithm (implement in `lib/scoring/novelty.ts`)

```
For a new chunk C with embedding E:
  1. Find the 50 most recent TranscriptChunks linked to the same Entity (via ChunkEntity)
  2. Compute cosine similarity between E and each of those 50 embeddings
  3. noveltyScore = 1 - max(similarities)
     (higher distance from nearest neighbor = more novel)
  4. If fewer than 5 prior chunks exist for entity: noveltyScore = 0.8 (default "likely novel")
  5. Clamp result to [0.0, 1.0]
```

**SQL query pattern:**
```sql
SELECT embedding
FROM "TranscriptChunk" tc
JOIN "ChunkEntity" ce ON ce."chunkId" = tc.id
WHERE ce."entityId" = $entityId
ORDER BY tc."createdAt" DESC
LIMIT 50;
```

**Cosine similarity (TypeScript):**
```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (magA * magB);
}
```

**When to run:** After entity extraction, during ingestion pipeline. Not a blocking step —
if it fails, store `noveltyScore = null` and continue.

---

## 6. Conviction Scoring — v1 Algorithm

**Decision: LLM prompt-based scoring via Claude API.**

Rationale: Conviction requires semantic understanding that rule-based systems do poorly.
A simple prompt is fast to implement, easy to iterate, and surprisingly consistent.

### Algorithm (implement in `lib/scoring/conviction.ts`)

**Model:** `claude-haiku-*` (fast, cheap, sufficient for classification)

**Prompt:**
```
You are a financial analyst evaluating speaker conviction.

Score the following transcript excerpt on conviction from 0.0 to 1.0.

Conviction means: the speaker expresses clear, confident, directional views.
High conviction (0.7–1.0): Declarative claims, quantified positions, explicit directional bets,
  repeated emphasis, causal explanations, explicit risk acknowledgment.
Low conviction (0.0–0.3): Vague hedging, "might", "could", "not sure", speculative musings,
  non-committal language.
Mid conviction (0.3–0.7): Mixed signals, some directional language with hedges.

Return ONLY a JSON object: {"conviction": 0.0}
No explanation. No other text.

Transcript:
"""
{chunkText}
"""
```

**Parse response:**
```typescript
const json = JSON.parse(response.content[0].text);
const convictionScore = Math.min(1, Math.max(0, json.conviction));
```

**When to run:** Same as novelty — during ingestion, non-blocking. Store `null` on failure.

**Cost estimate:** ~500 tokens per chunk at Haiku pricing ≈ $0.0004/chunk. Acceptable at MVP scale.

---

## 7. Entity Extraction — v1 Algorithm

**Decision: LLM prompt-based extraction via Claude API.**

### Algorithm (implement in `lib/ingestion/entityExtractor.ts`)

**Prompt:**
```
Extract all financial entities mentioned in this transcript excerpt.

Return ONLY a JSON array. Each item:
{
  "name": "display name",
  "normalizedName": "lowercase, no punctuation",
  "entityType": one of: ticker|company|person|investor|executive|topic|product|sector|fund,
  "ticker": "NVDA" or null,
  "confidence": 0.0 to 1.0,
  "mentionType": "direct" | "implied" | "contextual"
}

Rules:
- Include tickers, company names, people, investors, topics (e.g. "AI infrastructure", "semiconductor demand")
- If an entity has a well-known ticker, always include it
- Confidence < 0.5 should be omitted
- Return [] if no meaningful entities found

Transcript:
"""
{chunkText}
"""
```

**Post-processing:**
1. Upsert each entity into the `Entity` table by `normalizedName` + `entityType`
2. Create `ChunkEntity` row for each with confidence and mentionType
3. Discard entities with confidence < 0.6

---

## 8. Folder Structure

Claude Code should create this structure exactly. Do not deviate.

```
/
├── app/
│   ├── page.tsx                    # Home / ticker search
│   ├── feed/
│   │   └── [ticker]/
│   │       └── page.tsx            # Feed page for a ticker
│   └── api/
│       ├── ingest/
│       │   └── youtube/
│       │       └── route.ts        # POST /api/ingest/youtube
│       ├── search/
│       │   └── route.ts            # GET /api/search
│       ├── feed/
│       │   └── [ticker]/
│       │       └── route.ts        # GET /api/feed/[ticker]
│       └── transcript/
│           └── [episodeId]/
│               └── route.ts        # GET /api/transcript/[episodeId]
├── lib/
│   ├── db.ts                       # Prisma client singleton
│   ├── ingestion/
│   │   ├── youtube.ts              # YouTube fetch + metadata
│   │   ├── chunker.ts              # Chunking algorithm
│   │   ├── embedder.ts             # OpenAI embedding calls
│   │   └── entityExtractor.ts      # Entity extraction
│   ├── scoring/
│   │   ├── novelty.ts              # Novelty scoring v1
│   │   └── conviction.ts           # Conviction scoring v1
│   └── retrieval/
│       └── search.ts               # Semantic search + filtering
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── components/
│   ├── FeedCard.tsx                # TranscriptChunk feed item
│   ├── FeedList.tsx                # List of FeedCards with sort/filter
│   └── SearchBar.tsx               # Ticker search input
├── .env.local                      # Never commit
├── .env.example                    # Commit this
└── package.json
```

---

## 9. API Contract

### POST /api/ingest/youtube

**Request:**
```json
{
  "videoUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
  "sourceId": "uuid-of-source-record"
}
```

**Response (success):**
```json
{
  "episodeId": "uuid",
  "chunksCreated": 47,
  "entitiesFound": 12,
  "status": "completed"
}
```

**Response (failure):**
```json
{
  "error": "Transcript unavailable for this video",
  "status": "failed"
}
```

---

### GET /api/feed/[ticker]

**Query params:**
```
sort    = "recency" | "novelty" | "conviction"   (default: recency)
limit   = integer                                 (default: 20, max: 100)
offset  = integer                                 (default: 0)
speaker = speaker uuid                            (optional filter)
source  = source uuid                             (optional filter)
from    = ISO date string                         (optional filter)
to      = ISO date string                         (optional filter)
```

**Response:**
```json
{
  "ticker": "NVDA",
  "total": 143,
  "chunks": [
    {
      "id": "uuid",
      "text": "Jensen said that inference demand is accelerating...",
      "startTimeSeconds": 1842,
      "endTimeSeconds": 1901,
      "noveltyScore": 0.74,
      "convictionScore": 0.88,
      "speaker": {
        "id": "uuid",
        "name": "Jensen Huang"
      },
      "episode": {
        "id": "uuid",
        "title": "All-In E147",
        "publishedAt": "2024-03-01T00:00:00Z",
        "source": {
          "name": "All-In Podcast",
          "platform": "youtube"
        }
      }
    }
  ]
}
```

---

### GET /api/search

**Query params:**
```
q       = search query string  (semantic search)
limit   = integer              (default: 10)
ticker  = ticker string        (optional filter)
```

**Response:** Same shape as feed endpoint `chunks` array.

---

### GET /api/transcript/[episodeId]

**Response:**
```json
{
  "episode": {
    "id": "uuid",
    "title": "...",
    "publishedAt": "...",
    "source": {}
  },
  "chunks": [
    {
      "id": "uuid",
      "chunkIndex": 0,
      "text": "...",
      "startTimeSeconds": 0,
      "endTimeSeconds": 42,
      "speaker": {},
      "noveltyScore": 0.5,
      "convictionScore": 0.6
    }
  ]
}
```

---

## 10. Ingestion Pipeline — Execution Order

When `POST /api/ingest/youtube` is called, execute in this exact order:

```
1.  Validate videoUrl, extract videoId
2.  Fetch YouTube metadata (title, description, publishedAt, duration)
3.  Upsert Episode record with status = "processing"
4.  Fetch transcript via youtube-transcript
5.  If transcript unavailable → set status = "failed", return error
6.  Run chunker → Array<RawChunk>
7.  For each chunk:
    a. Generate embedding (OpenAI)
    b. Extract entities (Claude)
    c. Score novelty (requires embedding + prior chunks for entity)
    d. Score conviction (Claude)
    e. Persist TranscriptChunk with all scores
    f. Upsert entities, create ChunkEntity links
8.  Set Episode status = "completed"
9.  Return summary response
```

**Error handling:** Steps 7c and 7d are non-blocking. If they fail, store `null` scores and continue.
Steps 7a and 7b are blocking — if embedding fails, retry once, then mark chunk as failed and skip.

---

## Decision Comparison: ChatGPT (Original) vs. This Spec

| Decision Area | ChatGPT's Implicit Choice | This Spec's Explicit Choice | Rationale |
|---|---|---|---|
| YouTube ingestion library | Unspecified ("YouTube ingestion") | `youtube-transcript` npm package | Simplest path; captions already exist for most financial YouTube content |
| STT pipeline | Implied needed (vague) | Explicitly deferred to Phase 4 | Adds significant complexity with no MVP benefit if captions exist |
| Embedding model | "embeddings API" (unspecified) | `text-embedding-3-small`, 1536 dims | Cost-quality balance; specifies pgvector dimension |
| Embedding dimensions | Unspecified | 1536 | Required for `vector(1536)` Prisma type and HNSW index creation |
| Chunking unit | "300–800 tokens, semantic, overlapping" | 400 target / 600 max / 80 overlap tokens, sentence-boundary splits via tiktoken | Implementable algorithm vs. a philosophy |
| Tokenizer library | Unspecified | `js-tiktoken` | Standard, matches OpenAI tokenization |
| Novelty algorithm | "semantic distance, cluster rarity, contradiction" (aspirational) | Cosine distance from 50 most recent same-entity chunks | Naive but immediately implementable |
| Conviction algorithm | "declarative language, quantified claims" (rule-based vibes) | LLM prompt (Claude Haiku) returning JSON score | Rule-based conviction is brittle; LLM is simple and iterable |
| Entity extraction method | "entity extraction" (unspecified) | LLM prompt (Claude) returning structured JSON | Most reliable for financial entities including topics |
| Entity extraction model | Unspecified | Claude (same API call pattern) | Consistent with conviction scoring; no additional dependencies |
| Folder structure | Unspecified | Fully specified 2-level tree | Prevents Claude Code from inventing structure |
| API request/response shapes | Route names only | Full JSON contracts with query params | Prevents interface drift between frontend and backend |
| Pipeline execution order | "build ingestion worker" (vague) | 9-step ordered sequence with error handling notes | Eliminates ordering ambiguity |
| Score failure handling | Unspecified | Non-blocking; store `null` on failure | Prevents one bad chunk from halting full ingestion |
| Environment variables | Unspecified | Full `.env.local` + `.env.example` | Required for Claude Code to bootstrap the project |
| Prisma vector type | "pgvector" (implied) | `Unsupported("vector(1536)")` syntax | Exact Prisma syntax for pgvector; not obvious |
| Vector index type | "HNSW preferred" (mentioned once) | HNSW with `vector_cosine_ops` SQL | Exact SQL statement ready to run |
| Feed sort default | Unspecified | `recency` | Sensible default; avoids null-score sorting bugs early on |
