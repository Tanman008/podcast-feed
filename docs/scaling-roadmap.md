# scaling-roadmap.md
# Post-MVP Scaling Roadmap
## What to build after the first product works

This document covers everything *after* Phase 1 ships and validates the core loop
(ingest YouTube → chunk → embed → score → ticker feed). It is deliberately NOT for
Claude Code to build now — it exists so early architectural choices don't paint you
into a corner, and so you have a sequenced plan when the MVP proves out.

The ordering principle: **scale the bottleneck you actually hit, not the one you imagine.**
Each stage below lists the *signal* that tells you it's time.

---

## Stage A — Ingestion Throughput
**Signal:** You want to ingest faster than one worker can process, or back-catalogs
(hundreds of episodes) take too long.

### A1. Multiple workers
The job table already uses `FOR UPDATE SKIP LOCKED`, so this is a zero-code change:
run N worker processes. They will not collide. Start here before anything fancier.

### A2. Graduate from the Postgres job table to a real queue
Only if you exceed ~thousands of jobs/day or need priority lanes, retries with dead-letter
queues, or fan-out. Options in order of operational simplicity:
- **Inngest** or **Trigger.dev** — managed, durable, minimal ops (recommended)
- **BullMQ + Redis** — more control, more ops
- **SQS** — if already on AWS

Migration is contained: swap the `claim.ts` and enqueue logic; the pipeline stays identical.

### A3. Idempotency + dedupe
At volume you'll re-ingest the same video. Enforce via the existing
`@@unique([sourceId, externalId])` on Episode, and make the worker check for an existing
completed Episode before reprocessing. Add a `force` flag for intentional re-runs.

---

## Stage B — Retrieval Quality
**Signal:** Users say the feed surfaces irrelevant or low-signal chunks. This is the
product's core value — invest here aggressively and early.

### B1. Add a reranking layer
Vector search alone (cosine over `text-embedding-3-small`) returns *similar*, not *best*.
Add a cross-encoder reranker over the top ~50 vector hits before returning top 20:
- **Cohere Rerank** or **Voyage rerank-2** (managed, drop-in)
- Rerank by query relevance, then blend with novelty/conviction for final ordering

### B2. Hybrid search (vector + keyword)
Pure semantic search misses exact ticker/number matches. Add Postgres full-text search
(`tsvector`) and fuse with vector results (Reciprocal Rank Fusion). Tickers, dollar figures,
and proper nouns benefit enormously.

### B3. Upgrade the embedding model
If retrieval quality plateaus, move to `text-embedding-3-large` (3072 dims). This is a
**migration, not a config change**: new column `embedding_large vector(3072)`, backfill all
chunks, rebuild the HNSW index, then cut over. Plan a backfill job. Budget for it.

### B4. Tune the HNSW index
Cold-start recall is poor on small tables. Once you have volume, tune `m` and
`ef_construction`, and set `ef_search` at query time. Revisit IVFFlat only if HNSW memory
becomes a cost problem at very large scale.

---

## Stage C — Signal Intelligence (Phase 2 of the original roadmap, hardened)
**Signal:** The naive novelty/conviction scores are "good enough to sort" but users don't
trust them. Time to make scoring defensible.

### C1. Novelty v2 — cluster-aware
Replace nearest-neighbor distance with cluster rarity: periodically cluster all chunks per
entity (HDBSCAN over embeddings), and score novelty by how small/new the chunk's cluster is.
Catches "this is a genuinely new angle" better than raw distance.

### C2. Conviction v2 — calibrated + multi-signal
The LLM-only score drifts. Add measurable signals (quantified-claim count, hedging-word
density, discussion duration on topic) and calibrate the blend against a small
human-labeled set. Track score distributions over time to detect drift.

### C3. Contradiction detection
The highest-value signal for investors: "Speaker A says X, Speaker B says not-X."
Detect via embedding opposition + LLM verification over chunks sharing an entity. This is
a genuine differentiator vs. transcript-search competitors.

### C4. Topic extraction + the Entity Graph
Build the `Topic`, `Cluster`, and relationship tables (deferred in schema.md). Enables
theme feeds ("AI infrastructure") and consensus/divergence views across speakers and time.

---

## Stage D — Multi-Source Ingestion (Phase 4 of original roadmap)
**Signal:** YouTube alone misses audio-only podcasts, earnings calls, and Spaces — and
users ask for them.

### D1. Audio STT pipeline
This is the big one deferred from MVP. For non-captioned sources:
- **Whisper** (self-hosted `whisper.cpp` or OpenAI's API) for transcription
- Audio fetch via `yt-dlp` (YouTube audio), podcast RSS enclosures, Spotify/Apple where ToS allows
- New worker type: `audio-ingest` → download → normalize → transcribe → hand off to the
  existing chunk/embed/score pipeline (the back half is unchanged — good architecture payoff)

### D2. Diarization + real speaker ID
Now the speaker filter becomes real. Use **pyannote** for diarization, then map speaker
clusters to identities via voice fingerprints or LLM context. Backfill `speakerId` on
existing chunks where possible. This retires the "best-effort speaker guess" hack.

### D3. Transcript confidence scoring
STT is imperfect. Store per-chunk confidence; down-weight low-confidence chunks in ranking
and flag them in the UI.

### D4. Source-specific adapters
Earnings calls (structured, speaker-labeled transcripts often available), conference talks,
X Spaces (API access permitting). Each is an adapter feeding the same downstream pipeline.

---

## Stage E — Personalized Workspace (Phase 3 of original roadmap)
**Signal:** Users return daily and want to save/customize rather than re-search.

### E1. Auth + real users
`Feed.userId` is already nullable-ready. Add auth (Clerk/Auth.js), backfill ownership,
make `userId` required going forward.

### E2. Custom + oversight feeds
Build the feed-builder UI on the existing `Feed`/`FeedEntity` tables. Oversight feeds =
multi-entity feeds with weighted ranking (the `weight` column is already there).

### E3. Saved filters + personalized ranking
Persist scoring thresholds and filter sets per user. Learn per-user relevance weights from
click/dwell behavior. This is where the `relevanceScore` column earns its keep.

### E4. Alerts
Novel-mention alerts, conviction spikes, contradiction alerts, sentiment shifts. Build on
top of the scoring layer once C1–C3 are trustworthy. Delivery via email/push.

---

## Stage F — Platform Hardening
**Signal:** You have paying users and downtime/cost/security now matter.

### F1. Observability
Structured logging, per-stage pipeline metrics (chunk count, score distributions, API cost
per episode), and tracing on ingestion. You cannot tune scoring you cannot observe — this
was an explicit MVP principle; make it real here.

### F2. Cost controls
Per-episode API cost tracking (embeddings + LLM). Batch and cache aggressively. Consider
cheaper/open embedding models for back-catalog bulk ingestion.

### F3. Caching layer
Cache hot ticker feeds and search results (Redis or Postgres materialized views). Feeds for
popular tickers (NVDA, TSLA) are read constantly and change slowly.

### F4. Data lifecycle
Archival strategy for old chunks, embedding re-generation policy when models change, and
GDPR/deletion paths once you have user data.

---

## Architectural Guardrails to Preserve While Scaling

These are the decisions that keep the system flexible — do not violate them under deadline pressure:

1. **The pipeline back-half is source-agnostic.** Chunk → embed → score → store must never
   know whether the source was YouTube captions or Whisper audio. Every new source feeds the
   same downstream. (This is why adding STT in Stage D is cheap.)
2. **Scoring stays decoupled and re-runnable.** Scores are columns updated by isolated
   functions, never baked into ingestion irreversibly. You must always be able to re-score the
   whole corpus when an algorithm improves.
3. **TranscriptChunk remains the atomic unit.** Resist the urge to make Episode or Speaker
   primary. Every scaling feature attaches to chunks.
4. **Postgres-first until proven insufficient.** Don't add Redis, a queue, or a vector DB
   (Pinecone/Weaviate) until you've measured a real Postgres limit. pgvector scales further
   than people assume.
5. **Novelty is order-dependent by design.** Never "fix" early-episode high-novelty scores;
   they're correct. If you re-score, re-score against point-in-time corpus state if temporal
   accuracy matters.

---

## Suggested Sequencing (the path most likely to matter)

```
MVP ships
   │
   ▼
B1–B2  Retrieval quality (reranking + hybrid)   ← do this first; it IS the product
   │
   ▼
A1     Multiple workers (free throughput)
   │
   ▼
C2–C3  Trustworthy conviction + contradiction    ← the differentiator
   │
   ▼
E1–E2  Auth + custom feeds                        ← retention
   │
   ▼
D1–D2  Audio STT + diarization                    ← breadth (biggest eng lift)
   │
   ▼
F      Hardening as paying users arrive
```

Retrieval quality before breadth. A narrow feed that surfaces brilliant insight beats a
broad feed full of noise — and it's far cheaper to build.
