# Podcast Intelligence Platform

## What this is
An investor-focused transcript intelligence feed. Transforms longform financial audio
(podcasts, interviews, earnings calls) into a searchable, high-signal ticker feed.

The fundamental unit of the system is the TranscriptChunk — not the podcast, episode,
or transcript. Every retrieval, scoring, and feed operation revolves around chunks.

---

## Read before writing any code

Read ALL of these files before touching any implementation:

1. `docs/pipeline-architecture.md` — **start here**; supersedes Section 10 of implementation-spec.md
2. `docs/implementation-spec.md` — environment variables, libraries, algorithms, folder structure, API contracts
3. `docs/schema.md` — full table and field reference
4. `prisma/schema.prisma` — source of truth for the data model
5. `docs/BOOTSTRAP.md` — exact setup sequence including Docker, pgvector, migrations, seed

The scaling-roadmap.md and roadmap.md are context — read them but do not build anything from Phase 2+ yet.

---

## Current phase: Phase 1 only

Build only what is in Phase 1. Do not build anything from Phase 2, Phase 3, Phase 4,
or the scaling roadmap. When in doubt, do less.

---

## Hard rules — never violate these

### Pipeline
- Ingestion work NEVER runs inside a Vercel API route. The route enqueues an IngestionJob and returns immediately. The worker does the work.
- Novelty scoring NEVER runs before chunks and ChunkEntity links are persisted. Two-pass design is mandatory: Pass 1 = persist + embed + entities + conviction, Pass 2 = novelty.
- Embedding is always batched per episode (one OpenAI call, array input). Never embed one chunk at a time.
- Entity extraction + conviction scoring + speakerGuess are always ONE combined Claude call per chunk. Never separate calls.
- All external API calls (OpenAI, Anthropic) must have retry with exponential backoff.
- Per-chunk LLM calls run at concurrency 8 via p-limit. Never fully serial, never fully parallel.

### Data model
- Embedding model is text-embedding-3-small, 1536 dimensions. Do not change.
- Prisma vector type is Unsupported("vector(1536)"). Exact syntax matters.
- HNSW index must be created manually after migration — Prisma cannot manage it.
- speakerId is nullable. Most chunks will have null speakerId. This is correct.

### Infrastructure
- Use tsx, not ts-node, for the worker process.
- Use ankane/pgvector Docker image for local Postgres (not plain postgres image).
- Job claiming uses FOR UPDATE SKIP LOCKED — do not change this pattern.
- No Redis, no BullMQ, no SQS in Phase 1. Postgres job table only.

### UI
- Speaker filter only renders if ≥20% of a feed's chunks have a non-null speakerId.
- Default sort order for feeds is recency.
- Scores (noveltyScore, convictionScore) may be null — UI must handle null gracefully.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js + TypeScript |
| Styling | Tailwind |
| ORM | Prisma 5 |
| Database | Postgres + pgvector |
| Embeddings | OpenAI text-embedding-3-small |
| LLM (scoring) | Claude Haiku (combined entity+conviction+speaker call) |
| Concurrency | p-limit (cap 8) |
| Tokenizer | js-tiktoken |
| YouTube captions | youtube-transcript npm package |
| Worker runtime | tsx (long-running Node process) |
| App hosting | Vercel |
| Worker hosting | Railway or Render |

---

## Folder structure

```
/
├── app/
│   ├── page.tsx
│   ├── feed/[ticker]/page.tsx
│   └── api/
│       ├── ingest/youtube/route.ts       ← enqueue only, returns jobId
│       ├── ingest/jobs/[jobId]/route.ts  ← polling endpoint
│       ├── search/route.ts
│       ├── feed/[ticker]/route.ts
│       └── transcript/[episodeId]/route.ts
├── lib/
│   ├── db.ts                             ← Prisma singleton
│   ├── ingestion/
│   │   ├── youtube.ts
│   │   ├── chunker.ts
│   │   ├── embedder.ts
│   │   └── entityExtractor.ts            ← combined LLM call
│   ├── scoring/
│   │   ├── novelty.ts                    ← Pass 2 only
│   │   └── conviction.ts                 ← runs in Pass 1 via combined call
│   └── retrieval/
│       └── search.ts
├── lib/worker/
│   ├── index.ts                          ← poll loop
│   ├── processJob.ts                     ← two-pass pipeline
│   └── claim.ts                          ← FOR UPDATE SKIP LOCKED
├── components/
│   ├── FeedCard.tsx
│   ├── FeedList.tsx
│   └── SearchBar.tsx
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── docs/                                 ← all planning documents
├── CLAUDE.md                             ← this file
├── .env.local                            ← never commit
└── .env.example                          ← commit this
```

---

## Key test videos (captions verified)

Use these for ingestion testing:

| Video ID | Source | Notes |
|---|---|---|
| TbKMBR4k5_k | All-In Podcast | Heavy NVDA/AI discussion |
| oFfVt3S51T4 | Acquired | NVIDIA episode |
| UTRmWPnOEpg | Dwarkesh Podcast | Jensen Huang interview |
