# schema.md

# Database Schema

## Schema Philosophy

The database should optimize for:

* transcript retrieval quality
* semantic search
* ranking experimentation
* entity relationships
* rapid iteration

The schema is intentionally:

* Postgres-centric
* monolithic
* retrieval-oriented
* Claim-centric (output unit) / TranscriptChunk-centric (retrieval unit)

The system should prioritize flexibility over premature optimization.

---

# Core Architectural Principle

The pipeline has two primary objects:

## TranscriptChunk — retrieval unit

Everything important connects to TranscriptChunk:

* embeddings (pgvector HNSW)
* entity links (ChunkEntity)
* scoring (importanceScore, noveltyScore, convictionScore)
* claim extraction input

## Claim — output unit

The feed never surfaces raw chunks. Every match shown to the user is a Claim:

* extracted from a TranscriptChunk via LLM
* one chunk → 0–7 claims
* linked to InterestMatch for delivery

---

# Entity Relationship Overview

```text
Source
  └── Episode
        └── TranscriptChunk
              ├── ChunkEntity → Entity
              └── Claim
                    └── InterestMatch ← UserInterest

IngestionJob        (standalone — tracks worker pipeline state)
Feed
  └── FeedEntity → Entity
```

---

# Enumerations

## SourceType

* youtube
* spotify
* apple_podcast
* earnings_call
* x_space
* interview
* conference

## EntityType

* ticker
* company
* person
* investor
* executive
* topic
* product
* sector
* fund

## MentionType

* direct
* implied
* contextual

## TranscriptStatus

* pending
* processing
* completed
* failed

## JobStatus

* queued
* running
* completed
* failed

---

# Core Tables

# Source

Represents a podcast/channel/provider.

## Fields

| Field              | Type      | Notes                                |
| ------------------ | --------- | ------------------------------------ |
| id                 | uuid      | Primary key                          |
| name               | string    | Display name                         |
| slug               | string    | URL-safe unique identifier           |
| sourceType         | enum      | SourceType                           |
| platform           | string    | youtube/spotify/etc                  |
| url                | string    | Canonical source URL                 |
| description        | text      | Optional                             |
| imageUrl           | string    | Optional                             |
| minDurationSeconds | int       | Optional — filter short episodes     |
| maxDurationSeconds | int       | Optional — filter long episodes      |
| checkIntervalHours | int       | Default 1 — RSS monitor frequency    |
| following          | bool      | Default true — whether monitor runs  |
| lastCheckedAt      | timestamp | Set by RSS monitor on each check     |
| createdAt          | timestamp |                                      |
| updatedAt          | timestamp |                                      |

## Indexes

* slug (unique)
* sourceType
* platform

---

# Episode

Represents one ingestible media unit.

## Fields

| Field            | Type      | Notes                        |
| ---------------- | --------- | ---------------------------- |
| id               | uuid      | Primary key                  |
| sourceId         | uuid      | FK → Source                  |
| externalId       | string    | YouTube video ID, etc        |
| title            | string    |                              |
| description      | text      |                              |
| publishedAt      | timestamp | From RSS feed; never overwritten by yt-dlp if already set |
| durationSeconds  | integer   |                              |
| thumbnailUrl     | string    |                              |
| transcriptStatus | enum      | TranscriptStatus             |
| rawTranscript    | text      | Optional original transcript |
| errorMessage     | text      | Populated on failure         |
| createdAt        | timestamp |                              |
| updatedAt        | timestamp |                              |

## Indexes

* sourceId + externalId (unique together)
* publishedAt
* transcriptStatus

---

# Speaker

Represents an identified speaker across episodes.

## Fields

| Field          | Type      | Notes                      |
| -------------- | --------- | -------------------------- |
| id             | uuid      | Primary key                |
| name           | string    | Display name               |
| normalizedName | string    | Deduplicated name (unique) |
| bio            | text      | Optional                   |
| imageUrl       | string    | Optional                   |
| metadataJson   | jsonb     | Flexible metadata          |
| createdAt      | timestamp |                            |
| updatedAt      | timestamp |                            |

## Indexes

* normalizedName (unique)

---

# TranscriptChunk

The primary retrieval object in the system.

## Chunking algorithm (word-based, speaker-turn-aware)

* Target: 250 words
* Maximum: 300 words
* Overlap: 30 words (last sentences of previous chunk, same speaker only)
* Minimum: 20 words (discard shorter trailing fragments)
* Speaker change is ALWAYS a chunk boundary — speaker turns are never merged
* Long turns (>300 words) are split at sentence boundaries, targeting 250 words each

## Fields

| Field             | Type           | Notes                                                    |
| ----------------- | -------------- | -------------------------------------------------------- |
| id                | uuid           | Primary key                                              |
| episodeId         | uuid           | FK → Episode                                             |
| speakerId         | uuid           | FK → Speaker (nullable — usually null)                   |
| chunkIndex        | int            | Sequential order within episode                          |
| text              | text           | Original chunk text                                      |
| cleanedText       | text           | Whitespace-normalized, lowercased                        |
| keyQuote          | text           | Most signal-rich sentence, extracted by LLM              |
| keyPhrase         | text           | Most critical 2–5 word phrase within keyQuote            |
| speakerLabel      | text           | Raw diarization label ("0", "1", …) — nullable           |
| speakerName       | text           | Resolved human name from LLM — nullable                  |
| summary           | text           | Optional LLM-generated summary                           |
| startTimeSeconds  | float          |                                                          |
| endTimeSeconds    | float          |                                                          |
| tokenCount        | int            |                                                          |
| embedding         | vector(1536)   | text-embedding-3-small via pgvector                      |
| importanceScore   | float          | claimSpecificityScore from entity extractor              |
| noveltyScore      | float          | Set in Pass 2 after entity links exist                   |
| convictionScore   | float          | forwardLookingScore from entity extractor (Pass 1)       |
| relevanceScore    | float          | Speaker authority proxy (nullable)                       |
| sentimentScore    | float          | Optional                                                 |
| chunkType         | text           | ARGUMENT\|POSITION\|DATA\|THESIS\|OPINION\|CHITCHAT      |
| claimUnit         | text           | Legacy cached claim span (unused post-Claim table)       |
| claimCompleteness | float          | Legacy completeness score (unused post-Claim table)      |
| claimAllParts     | bool           | Legacy flag (unused post-Claim table)                    |
| metadataJson      | jsonb          |                                                          |
| createdAt         | timestamp      |                                                          |
| updatedAt         | timestamp      |                                                          |

Also has a generated `searchVector tsvector` column (GIN indexed) for full-text search — not managed by Prisma.

## Indexes

### Standard Indexes

* episodeId
* speakerId
* chunkIndex
* importanceScore
* noveltyScore
* convictionScore
* createdAt

### Vector Index

* HNSW on embedding with vector_cosine_ops
* Create manually after migration (Prisma cannot manage this):

```sql
CREATE INDEX IF NOT EXISTS transcript_chunk_embedding_idx
ON "TranscriptChunk"
USING hnsw (embedding vector_cosine_ops);
```

---

# Claim

A single investor-relevant assertion extracted from a TranscriptChunk. This is the output unit of the feed.

One chunk produces 0–7 claims via a single gpt-4o-mini call. Claims are extracted with boundary expansion: if a claim starts within the first 30 words or ends within the last 30 words of its chunk, a second LLM call fetches the adjacent same-speaker chunk and extends the highlight.

## Fields

| Field              | Type      | Notes                                                              |
| ------------------ | --------- | ------------------------------------------------------------------ |
| id                 | uuid      | Primary key                                                        |
| chunkId            | uuid      | FK → TranscriptChunk (cascade delete)                              |
| highlight          | string    | Verbatim 2-3 sentence span from the chunk text                     |
| startSentenceIndex | int       | Index of first sentence in highlight within the chunk              |
| endSentenceIndex   | int       | Index of last sentence in highlight within the chunk               |
| primarySubject     | string    | Entity the claim is primarily ABOUT (nullable)                     |
| mentionedEntities  | string[]  | Other entities referenced in the claim                             |
| claimType          | string    | unit_economics\|transaction\|growth\|thesis\|position\|competitive\|valuation\|guidance |
| specificity        | float     | 0.0–1.0 — how specific/measurable the claim is                     |
| completeness       | float     | 0.4–1.0 — how complete/self-contained the highlight is             |
| gloss              | text      | Optional LLM-generated investor framing (deprecated — no longer called) |
| numbers            | string[]  | Verbatim quantified facts: dollar amounts, percentages, multiples, counts |
| createdAt          | timestamp |                                                                    |

## Indexes

* chunkId
* claimType
* completeness

---

# Entity

Represents a structured financial concept.

Examples: NVDA (ticker), Jensen Huang (executive), OpenAI (company), "AI infrastructure" (topic)

## Fields

| Field          | Type      | Notes                          |
| -------------- | --------- | ------------------------------ |
| id             | uuid      | Primary key                    |
| entityType     | enum      | EntityType                     |
| name           | string    | Display name                   |
| normalizedName | string    | Deduplicated name              |
| ticker         | string    | Optional (for ticker entities) |
| description    | text      | Optional                       |
| metadataJson   | jsonb     | Flexible metadata              |
| createdAt      | timestamp |                                |
| updatedAt      | timestamp |                                |

## Indexes

* normalizedName + entityType (unique together)
* entityType
* ticker

---

# ChunkEntity

Join table linking TranscriptChunks to Entities.

Powers ticker feeds, semantic filtering, graph traversal, novelty scoring.

## Fields

| Field       | Type      | Notes                       |
| ----------- | --------- | --------------------------- |
| id          | uuid      | Primary key                 |
| chunkId     | uuid      | FK → TranscriptChunk        |
| entityId    | uuid      | FK → Entity                 |
| confidence  | float     | Extraction confidence 0–1   |
| mentionType | enum      | MentionType                 |
| createdAt   | timestamp |                             |

## Indexes

* chunkId + entityId (unique together)
* chunkId
* entityId
* confidence

---

# UserInterest

An investor's monitoring term. Used to drive the Interest feed.

Phase 1: userId is a free-text label ("default") — no auth.

## Fields

| Field     | Type      | Notes                           |
| --------- | --------- | ------------------------------- |
| id        | uuid      | Primary key                     |
| userId    | string    | Default "default" until auth    |
| term      | string    | Raw query string as entered     |
| createdAt | timestamp |                                 |

## Indexes

* userId

---

# InterestMatch

Pre-computed top hits for one interest × claim pair.

Capped at MAX_CLAIMS_PER_EPISODE (20) per episode per interest. Unique on (interestId, claimId).

Scoring formula: `chunkCombinedScore × claimTypeWeight × entityWeight × max(0.35, forwardLookingScore)`

Where chunkCombinedScore = `0.60 × vectorSimilarity + 0.20 × importanceScore + 0.15 × forwardLookingScore + 0.05 × authorityScore`

Claims are filtered at query time: `completeness >= 0.5 AND specificity >= 0.4`

## Fields

| Field        | Type      | Notes                                          |
| ------------ | --------- | ---------------------------------------------- |
| id           | uuid      | Primary key                                    |
| interestId   | uuid      | FK → UserInterest (cascade delete)             |
| episodeId    | uuid      | FK → Episode (cascade delete)                  |
| chunkId      | uuid      | FK → TranscriptChunk (cascade delete)          |
| claimId      | uuid      | FK → Claim (cascade delete)                    |
| score        | float     | Final ranked score                             |
| entityWeight | float     | Default 1.0 — boosted when term matches entity |
| quality      | string    | 'high' \| 'low' — completeness + entity gate   |
| createdAt    | timestamp |                                                |

## Indexes

* interestId + claimId (unique together)
* interestId
* episodeId
* score
* createdAt

---

# IngestionJob

Tracks the state of a background ingestion pipeline run.

The API route enqueues a job and returns immediately. The worker polls this table and processes jobs.

## Fields

| Field        | Type      | Notes                              |
| ------------ | --------- | ---------------------------------- |
| id           | uuid      | Primary key                        |
| videoUrl     | string    | Input YouTube URL                  |
| sourceId     | uuid      | FK → Source                        |
| episodeId    | uuid      | Populated after Episode is created |
| status       | enum      | JobStatus                          |
| progress     | integer   | 0–100 for client polling           |
| chunksTotal  | integer   | Set after chunking                 |
| chunksDone   | integer   | Incremented per chunk              |
| errorMessage | text      | Populated on failure               |
| attempts     | integer   | Retry counter                      |
| createdAt    | timestamp |                                    |
| startedAt    | timestamp |                                    |
| completedAt  | timestamp |                                    |

## Indexes

* status
* createdAt

---

# Feed

A user-defined intelligence feed (ticker/entity based, not interest-based).

## Fields

| Field       | Type      | Notes                          |
| ----------- | --------- | ------------------------------ |
| id          | uuid      | Primary key                    |
| userId      | uuid      | Nullable until auth is added   |
| name        | string    |                                |
| description | text      |                                |
| createdAt   | timestamp |                                |
| updatedAt   | timestamp |                                |

## Indexes

* userId

---

# FeedEntity

Maps feeds to entities.

## Fields

| Field     | Type      | Notes                           |
| --------- | --------- | ------------------------------- |
| id        | uuid      | Primary key                     |
| feedId    | uuid      | FK → Feed                       |
| entityId  | uuid      | FK → Entity                     |
| weight    | float     | Relevance weighting (default 1) |
| createdAt | timestamp |                                 |

## Indexes

* feedId + entityId (unique together)
* feedId
* entityId

---

# Novelty Scoring — Two-Pass Design

Novelty CANNOT be computed at chunk insertion time.
It requires the chunk's embedding AND its ChunkEntity links to already exist in the DB.

**Pass 1** (during ingestion): persist chunk + embedding + entities + conviction
**Pass 2** (after Pass 1 completes for the episode): compute noveltyScore for all chunks

Algorithm:
```
For each chunk C:
  For each linked entity E:
    Query 50 most recent chunks linked to E, excluding chunks from C's own episode
    novelty_for_E = 1 - max(cosine_similarity(C.embedding, prior.embedding))
    If <5 prior chunks exist for E: novelty_for_E = 0.8
  chunk.noveltyScore = MAX(novelty_for_E across all entities)
  Clamp to [0.0, 1.0]
```

---

# Embedding Strategy

## Model

text-embedding-3-small (OpenAI)
Dimensions: 1536
Prisma type: Unsupported("vector(1536)")

## Batching

Embed all chunks in an episode in a single OpenAI API call (array input). Never embed one chunk at a time.

---

# Combined LLM Call Strategy

Per chunk, make ONE gpt-4o-mini call for entity extraction + conviction + speakerGuess.
Per chunk, make ONE gpt-4o-mini call for claim extraction (separate pass, after entities are persisted).
Use p-limit (cap 8) for bounded concurrency.

Boundary expansion: if a claim's highlight starts within first 30 words or ends within last 30 words of its chunk, fetch adjacent same-speaker chunk and make a second gpt-4o-mini call to extend the highlight.

---

# Claim Extraction Scoring Gates

Applied at match time in `matchInterestAgainstEpisodes`:

* `completeness >= 0.5` — claim must be reasonably complete
* `specificity >= 0.4` — claim must not be vague/anaphoric
* `forwardFactor = max(0.35, chunk.forwardLookingScore ?? 0.5)` — multiplicative historical penalty

Claim type weights (multiplied into final score):
* transaction: 1.00
* unit_economics: 0.95
* position: 0.90
* valuation: 0.85
* guidance: 0.80
* growth: 0.75
* thesis: 0.70
* competitive: 0.50

---

# Retrieval Strategy

## Phase 1

* pgvector HNSW cosine similarity (120 vector candidates)
* Claims pre-extracted and scored — no LLM at query time
* Sort by: recency | noveltyScore | convictionScore
* Default sort: recency

## Phase 2+

* Cross-encoder reranking (Cohere or Voyage)
* Hybrid search: vector + Postgres full-text (tsvector)
* Topic clustering
* Personalization

---

# Infrastructure

## Database
Postgres + pgvector
Use ankane/pgvector Docker image for local dev (includes extension)
Supabase for production (pgvector included)

## ORM
Prisma 5 (with previewFeatures: postgresqlExtensions)

## Worker
Long-running Node process via tsx
Job claiming via FOR UPDATE SKIP LOCKED (safe for multiple workers)
