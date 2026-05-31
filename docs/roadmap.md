# roadmap.md

# Podcast Intelligence Platform

## Product Vision

Build an investor-focused intelligence platform that transforms longform audio content (podcasts, interviews, earnings calls, conference appearances, spaces, etc.) into a searchable, filterable, high-signal news feed.

The core insight:

Most important investment insights are buried inside hours of unstructured audio. Investors do not want full transcripts — they want the highest-signal excerpts, ranked intelligently.

The platform should:

* ingest longform financial audio content
* extract meaningful transcript excerpts
* map insights to securities/entities
* score excerpts by novelty and conviction
* create customizable ticker-specific feeds
* allow merging multiple feeds into broader oversight feeds

The long-term UX target is:

"Bloomberg Terminal-style intelligence feed for longform financial media."

---

# Core Product Concepts

## TranscriptChunk-Centric Architecture

The fundamental unit of the system is NOT:

* podcast
* episode
* transcript

The fundamental unit is:

## TranscriptChunk

A TranscriptChunk represents:

* a meaningful excerpt
* a semantically coherent passage
* a searchable/recommendable unit
* a feed item
* a scoring unit

Every major system revolves around TranscriptChunks:

* embeddings
* retrieval
* novelty scoring
* conviction scoring
* feed generation
* entity mapping
* clustering

---

# MVP Philosophy

The MVP should validate:

1. Can high-signal financial podcast excerpts be extracted?
2. Can they be mapped to securities/entities accurately?
3. Can investors discover valuable insights faster than existing workflows?
4. Can transcript intelligence become a usable feed product?

The MVP SHOULD NOT attempt to:

* replace Bloomberg
* build a general AI agent
* summarize the internet
* automate investing
* ingest every source immediately
* perfect ranking/scoring models

The MVP should optimize for:

* signal quality
* iteration speed
* ingestion reliability
* semantic retrieval quality
* clean architecture

---

# MVP Scope

## User Flow

User enters a ticker:

Example:

* NVDA
* TSLA
* META

The system returns:

* relevant transcript excerpts
* timestamps
* podcast/video source
* speaker attribution
* transcript context
* novelty score
* conviction score
* semantic relevance

User can:

* sort by recency
* sort by novelty
* sort by conviction
* filter by speaker (only shown if ≥20% of chunks have a resolved speaker)
* filter by source
* filter by date
* open full transcript context
* jump to source timestamp

---

# Phase Roadmap

# Phase 1 — Foundation Infrastructure

## Goal

Create a reliable ingestion and retrieval pipeline.

## Deliverables

### Infrastructure

* Next.js app
* Postgres database
* Prisma ORM
* pgvector support
* local development environment
* environment configuration

### Ingestion

* YouTube ingestion only initially (captions via youtube-transcript npm package)
* transcript retrieval
* metadata normalization
* transcript chunking (semantic, 400 target / 600 max tokens, 80-token overlap)
* embedding generation (text-embedding-3-small, 1536 dims, batched per episode)
* database persistence
* DB-backed IngestionJob table + polling worker (NOT Vercel serverless)

### Search + Feed

* ticker/entity search
* transcript chunk retrieval
* semantic similarity search
* basic feed UI
* transcript detail view

### Entities

Initial entity types:

* ticker
* company
* person
* investor
* executive
* topic
* product
* sector
* fund

### Feed UX

Basic feed cards showing:

* quote
* source
* timestamp
* speaker (when known; "Unknown speaker" otherwise)
* novelty score
* conviction score
* relevance score

## Explicitly Avoid During Phase 1

* Spotify ingestion
* Apple Podcasts ingestion
* audio download or STT/Whisper pipeline
* autonomous agents
* portfolio integrations
* notifications
* mobile app
* advanced recommendation systems
* social features
* full personalization
* distributed queues (Redis, SQS, BullMQ)

---

# Phase 2 — Signal Intelligence Layer

## Goal

Transform transcript excerpts into ranked investment signals.

## Deliverables

### Novelty Scoring

Novelty should estimate:

* how new an idea is
* whether the statement materially differs from historical discussion
* whether the statement contains differentiated insight

v1 algorithm: cosine distance from 50 most recent same-entity chunks (excluding same-episode).
Score = MAX novelty across linked entities. Default 0.8 if <5 prior chunks exist for entity.

### Conviction Scoring

Conviction should estimate:

* confidence level
* emphasis strength
* certainty language
* explanatory depth
* explicit positioning

v1 algorithm: LLM prompt-based (Claude Haiku), scored 0.0–1.0, returned as JSON.

### Entity Graph

Track relationships between:

* people
* tickers
* topics
* firms
* funds
* products

### Topic Extraction

Identify recurring themes:

* AI infrastructure
* semiconductor demand
* consumer weakness
* cloud spending
* valuation concerns

### Quote Clustering

Group semantically similar excerpts.

Use cases:

* consensus detection
* differentiated opinion detection
* trend tracking

---

# Phase 3 — Personalized Investor Workspace

## Goal

Create a customizable intelligence terminal.

## Deliverables

### Custom Feeds

User-created feeds by:

* ticker
* theme
* investor
* source
* sector

### Oversight Feeds

Merged multi-ticker feeds.

Example:

* AI Infrastructure
* Consumer Internet
* Semiconductors
* Energy

### Saved Filters

Users save:

* scoring thresholds
* speaker filters
* source filters
* topic filters

### Feed Ranking

Personalized relevance weighting.

### Alerts

Potential future additions:

* novel mention alerts
* conviction spikes
* contradiction alerts
* management sentiment changes

---

# Phase 4 — Multi-Source Audio Intelligence

## Goal

Expand ingestion breadth.

## Sources

* Spotify
* Apple Podcasts
* X Spaces
* earnings calls
* conference presentations
* YouTube live streams
* interviews
* webinars

## Additional Systems

* speech-to-text pipeline (Whisper)
* audio normalization
* diarization (pyannote)
* speaker identification
* transcript confidence estimation

---

# Architecture Philosophy

## Principles

### Keep Infrastructure Simple Initially

Prefer:

* monolith architecture
* Postgres-centric design
* server-side processing
* minimal services

Avoid early:

* microservices
* Kubernetes
* distributed queues
* excessive abstraction

### Optimize for Iteration Speed

The ranking/scoring systems will evolve constantly.

Architecture should prioritize:

* rapid experimentation
* easy scoring adjustments
* reproducibility
* observability

### Retrieval Quality Matters Most

The product lives or dies on:

* chunk quality
* entity accuracy
* semantic retrieval quality
* ranking quality

NOT on UI complexity.

---

# Technical Stack

## Frontend

* Next.js
* TypeScript
* Tailwind
* React Server Components

## Backend

* Next.js API routes/server actions (thin — enqueue only)
* Prisma
* Postgres
* pgvector
* Long-running Node worker (tsx)

## AI/ML

* OpenAI text-embedding-3-small (embeddings, batched)
* Claude Haiku (entity extraction + conviction + speaker guess, combined call)
* p-limit (concurrency control on LLM calls)

## Infrastructure

* Vercel (Next.js app only)
* Supabase/Postgres
* Railway or Render (background worker)

---

# Immediate Next Steps

## Step 1

Implement:

* Prisma schema (see prisma/schema.prisma)
* Postgres setup + pgvector extension
* HNSW index creation

## Step 2

Build:

* IngestionJob table + worker poll loop
* YouTube transcript fetcher
* Chunking pipeline (chunker.ts)
* Batch embedding generation

## Step 3

Build:

* Combined LLM call (entities + conviction + speakerGuess)
* Two-pass novelty scoring
* Semantic retrieval + ticker filtering

## Step 4

Build:

* Basic feed UI (FeedCard, FeedList, SearchBar)
* Transcript detail view
* Ingest progress polling UI

## Step 5

Iterate aggressively on:

* chunk quality
* ranking quality
* novelty scoring
* conviction scoring

---

# Success Metric

A successful product should eventually allow an investor to:

"Understand the most important new ideas about a company from dozens of hours of financial audio in minutes instead of days."
