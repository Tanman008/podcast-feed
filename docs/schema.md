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
* TranscriptChunk-centric

The system should prioritize flexibility over premature optimization.

---

# Core Architectural Principle

The primary object in the system is:

## TranscriptChunk

Everything important connects to TranscriptChunk:

* embeddings
* feeds
* ranking
* entities
* novelty
* conviction
* retrieval
* clustering

Episodes and sources are primarily metadata containers.

---

# Entity Relationship Overview

```text
Source
  └── Episode
        └── TranscriptChunk
              ├── ChunkEntity
              │     └── Entity
              └── Speaker

IngestionJob        (standalone — tracks worker pipeline state)
Feed
  └── FeedEntity
        └── Entity
```

---

# Enumerations

## SourceType

Possible values:

* youtube
* spotify
* apple_podcast
* earnings_call
* x_space
* interview
* conference

---

## EntityType

Possible values:

* ticker
* company
* person
* investor
* executive
* topic
* product
* sector
* fund

---

## MentionType

Possible values:

* direct
* implied
* contextual

---

## TranscriptStatus

Possible values:

* pending
* processing
* completed
* failed

---

## JobStatus

Possible values:

* queued
* running
* completed
* failed

---

# Core Tables

# Source

Represents a podcast/channel/provider.

Examples:

* All-In Podcast
* Dwarkesh Podcast
* Acquired
* NVIDIA Investor Relations

## Fields

| Field       | Type      | Notes                      |
| ----------- | --------- | -------------------------- |
| id          | uuid      | Primary key                |
| name        | string    | Display name               |
| slug        | string    | URL-safe unique identifier |
| sourceType  | enum      | SourceType                 |
| platform    | string    | youtube/spotify/etc        |
| url         | string    | Canonical source URL       |
| description | text      | Optional                   |
| imageUrl    | string    | Optional                   |
| createdAt   | timestamp |                            |
| updatedAt   | timestamp |                            |

## Indexes

* slug (unique)
* sourceType
* platform

---

# Episode

Represents one ingestible media unit.

Examples:

* podcast episode
* earnings call
* conference talk
* interview

## Fields

| Field            | Type      | Notes                        |
| ---------------- | --------- | ---------------------------- |
| id               | uuid      | Primary key                  |
| sourceId         | uuid      | FK -> Source                 |
| externalId       | string    | YouTube video ID, etc        |
| title            | string    |                              |
| description      | text      |                              |
| publishedAt      | timestamp |                              |
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

Represents an identified speaker.

## Fields

| Field          | Type      | Notes             |
| -------------- | --------- | ----------------- |
| id             | uuid      | Primary key       |
| name           | string    | Display name      |
| normalizedName | string    | Deduplicated name (unique) |
| bio            | text      | Optional          |
| imageUrl       | string    | Optional          |
| metadataJson   | jsonb     | Flexible metadata |
| createdAt      | timestamp |                   |
| updatedAt      | timestamp |                   |

## Indexes

* normalizedName (unique)

---

# TranscriptChunk

The most important table in the system.

Represents a semantically coherent transcript excerpt.

This is:

* the retrieval unit
* the feed unit
* the ranking unit
* the scoring unit

## Chunking parameters

* Target: 400 tokens
* Maximum: 600 tokens
* Overlap: 80 tokens
* Split on sentence boundaries (js-tiktoken for token counting)
* Minimum chunk size: 50 tokens (discard smaller trailing fragments)

## Fields

| Field            | Type      | Notes                                   |
| ---------------- | --------- | --------------------------------------- |
| id               | uuid      | Primary key                             |
| episodeId        | uuid      | FK -> Episode                           |
| speakerId        | uuid      | FK -> Speaker (nullable — often unknown)|
| chunkIndex       | integer   | Sequential ordering within episode      |
| text             | text      | Original chunk text                     |
| cleanedText      | text      | Whitespace-normalized, lowercased       |
| summary          | text      | Optional LLM-generated summary          |
| startTimeSeconds | float     |                                         |
| endTimeSeconds   | float     |                                         |
| tokenCount       | integer   |                                         |
| embedding        | vector(1536) | text-embedding-3-small via pgvector  |
| importanceScore  | float     | Ranking signal (nullable)               |
| noveltyScore     | float     | Set in Pass 2 after entity links exist  |
| convictionScore  | float     | Set in Pass 1 via combined LLM call     |
| relevanceScore   | float     | Ranking signal (nullable)               |
| sentimentScore   | float     | Optional                                |
| metadataJson     | jsonb     | Flexible metadata                       |
| createdAt        | timestamp |                                         |
| updatedAt        | timestamp |                                         |

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

* HNSW on embedding column with vector_cosine_ops
* Create manually after migration (Prisma cannot manage this):

```sql
CREATE INDEX IF NOT EXISTS transcript_chunk_embedding_idx
ON "TranscriptChunk"
USING hnsw (embedding vector_cosine_ops);
```

---

# Entity

Represents structured financial concepts.

Examples:

* NVDA (ticker)
* Jensen Huang (executive)
* OpenAI (company)
* "AI infrastructure" (topic)
* semiconductor demand (topic)

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

Join table linking transcript chunks to entities.

Enables:

* ticker feeds
* semantic filtering
* graph traversal
* relationship analysis
* novelty scoring (query prior chunks per entity)

## Fields

| Field       | Type      | Notes                       |
| ----------- | --------- | --------------------------- |
| id          | uuid      | Primary key                 |
| chunkId     | uuid      | FK -> TranscriptChunk       |
| entityId    | uuid      | FK -> Entity                |
| confidence  | float     | Extraction confidence 0–1   |
| mentionType | enum      | MentionType                 |
| createdAt   | timestamp |                             |

## Indexes

* chunkId + entityId (unique together)
* chunkId
* entityId
* confidence

---

# IngestionJob

Tracks the state of a background ingestion pipeline run.

The API route enqueues a job and returns immediately.
The worker polls this table and processes jobs.

## Fields

| Field        | Type      | Notes                              |
| ------------ | --------- | ---------------------------------- |
| id           | uuid      | Primary key                        |
| videoUrl     | string    | Input YouTube URL                  |
| sourceId     | uuid      | FK -> Source                       |
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

Represents a user-defined intelligence feed.

Examples:

* NVDA Feed
* AI Infrastructure
* Semiconductors
* Consumer Internet

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
| feedId    | uuid      | FK -> Feed                      |
| entityId  | uuid      | FK -> Entity                    |
| weight    | float     | Relevance weighting (default 1) |
| createdAt | timestamp |                                 |

## Indexes

* feedId + entityId (unique together)
* feedId
* entityId

---

# Implementation Order

Build models in this order:

1. Source
2. Episode
3. Speaker
4. TranscriptChunk
5. Entity
6. ChunkEntity
7. IngestionJob
8. Feed
9. FeedEntity

Feed and FeedEntity can wait until retrieval is functional.

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

Embed all chunks in an episode in a single OpenAI API call:

```typescript
openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: chunks.map(c => c.cleanedText),  // array input
})
```

## Future

When retrieval quality demands it, migrate to text-embedding-3-large (3072 dims).
This requires a new column, backfill job, and HNSW index rebuild.

---

# Combined LLM Call Strategy

Per chunk, make ONE Claude call returning entities + conviction + speakerGuess.
Use p-limit for bounded concurrency (8 concurrent calls).
Do NOT make separate calls for entity extraction and conviction scoring.

---

# Retrieval Strategy

## Phase 1

* pgvector HNSW cosine similarity
* ChunkEntity join for ticker/entity filtering
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
Prisma 5

## Worker
Long-running Node process via tsx
Job claiming via FOR UPDATE SKIP LOCKED (safe for multiple workers)

---

# Long-Term Data Opportunities

Future potential tables (do NOT build in Phase 1):

* Topic
* Cluster
* Claim
* Contradiction
* ConsensusTrend
* Portfolio
* Watchlist
* Alert
* Recommendation
