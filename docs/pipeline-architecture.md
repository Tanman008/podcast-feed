# pipeline-architecture.md
# Ingestion Pipeline — Corrected Architecture
## (Supersedes Section 10 of implementation-spec.md)

This document resolves three architectural flaws in the original pipeline spec:
1. Novelty scoring circular dependency (ordering error)
2. Sync-vs-worker contradiction (Vercel timeout vs. "no queues" mandate)
3. Per-chunk serial LLM calls (cost + latency)

It also fixes the speaker attribution gap.

---

## Core Decision: Ingestion Is a Worker, Not an API Route

**The Vercel API route does NOT do the work. It enqueues a job and returns immediately.**

This resolves the sync-vs-worker contradiction directly. The roadmap said "avoid distributed
queues" — and we still do. We do not introduce Redis, BullMQ, SQS, or Kafka. Instead we use a
**database-backed job table** (`IngestionJob`) polled by a long-running Node worker process.

This is the lightest possible async primitive:
- No new infrastructure (uses the Postgres we already have)
- No queue service to operate
- Survives restarts (job state is in the DB)
- Observable (you can query job status in SQL or Prisma Studio)
- Trivially upgradeable to a real queue in Phase 4 if volume demands it

This is fully consistent with "Postgres-centric, monolith, minimal services."

### Topology

```
┌─────────────────┐     enqueues      ┌──────────────┐
│ Vercel API route│ ────────────────> │ IngestionJob │  (Postgres table)
│ POST /ingest    │                   │   table      │
└─────────────────┘                   └──────────────┘
       │ returns jobId immediately            ▲
       ▼                                       │ polls every 5s
┌─────────────────┐                   ┌──────────────────────┐
│ Client polls    │                   │ Ingestion Worker      │
│ GET /ingest/:id │ <──── status ──── │ (long-running Node    │
└─────────────────┘                   │  process, NOT Vercel) │
                                       └──────────────────────┘
```

**Where the worker runs in Phase 1:** A local `npm run worker` process during development,
and a single Railway/Render/Fly background worker in production. NOT a Vercel serverless function.
Vercel runs only the Next.js app and the thin enqueue route.

---

## New Table: IngestionJob

Add to `schema.prisma`:

```prisma
enum JobStatus {
  queued
  running
  completed
  failed
}

model IngestionJob {
  id          String    @id @default(uuid())
  videoUrl    String
  sourceId    String
  episodeId   String?   // Populated once Episode is created
  status      JobStatus @default(queued)
  progress    Int       @default(0)  // 0–100, for client polling
  chunksTotal Int?
  chunksDone  Int       @default(0)
  errorMessage String?
  attempts    Int       @default(0)
  createdAt   DateTime  @default(now())
  startedAt   DateTime?
  completedAt DateTime?

  @@index([status])
  @@index([createdAt])
  @@map("IngestionJob")
}
```

---

## Corrected Pipeline Order (Fixes the Novelty Circular Dependency)

The original error: novelty was scored at step 7c, but it depends on the chunk's embedding
AND its entity links already being persisted (novelty compares against prior same-entity chunks
via `ChunkEntity` joins). You cannot find "prior same-entity chunks" for a chunk that isn't saved.

**The fix is a deliberate two-pass design within a single episode:**

### Pass 1 — Persist chunks with embeddings and entities (no novelty yet)

```
For the whole episode:
  1.  Worker picks up job → status = running, startedAt = now
  2.  Extract videoId, fetch YouTube metadata
  3.  Upsert Episode → status = processing
  4.  Fetch transcript via youtube-transcript
       └─ If unavailable: Episode.status = failed, Job.status = failed, return
  5.  Run chunker → RawChunk[]   (set Job.chunksTotal here)
  6.  BATCH embed all chunks (see Batching Strategy below)
  7.  For each chunk, run ONE combined LLM call (entity extraction + conviction + speaker guess)
  8.  Persist all TranscriptChunks WITH embeddings, conviction, speaker
  9.  Upsert Entities, create ChunkEntity links
       └─ Update Job.chunksDone incrementally for progress bar
```

At the end of Pass 1, every chunk is saved, embedded, and entity-linked.
`noveltyScore` is still `null`.

### Pass 2 — Score novelty (now the data it needs exists)

```
10. For each chunk just inserted:
     a. For each linked entity, query the 50 most recent OTHER chunks
        for that entity (excluding chunks from THIS episode to avoid
        self-comparison inflating familiarity)
     b. Compute novelty = 1 - max(cosineSimilarity)
     c. If an entity has <5 prior chunks: contribute 0.8
     d. chunk.noveltyScore = min across its entities (most-novel-against-any wins → use MAX, see note)
11. Bulk-update noveltyScore on all chunks
12. Episode.status = completed, Job.status = completed, progress = 100
```

> **Novelty aggregation note:** A chunk may map to multiple entities. Use the **MAX** novelty
> across its entities — a statement that is novel for *any* tracked entity is interesting.
> Using MIN would suppress cross-topic insights. (The original spec was silent on this.)

> **Why exclude same-episode chunks in Pass 2:** Within one episode a speaker repeats themes;
> comparing a chunk against its own episode's chunks would make everything look non-novel.
> Compare only against the historical corpus.

### Critical ordering guarantee

Novelty for episode N is computed against episodes 1..N-1 already in the corpus.
This means **novelty is inherently order-dependent on ingestion order** — the first episode
ever ingested for a ticker will always score ~0.8 (nothing to compare to). This is correct
and expected behavior, not a bug. Document it so it isn't "fixed" later.

---

## Batching Strategy (Fixes Cost + Latency)

The original design made 3 serial API calls per chunk (embed + extract + conviction).
For a 200-chunk episode that's 600 sequential round-trips → 10–20 min and high cost.

### Fix 1 — Batch embeddings

OpenAI's embeddings endpoint accepts **arrays of up to 2048 inputs per call**.
Embed an entire episode in 1–2 calls instead of 200.

```typescript
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: chunks.map(c => c.cleanedText),  // array, not single string
});
// response.data[i].embedding maps to chunks[i]
```

This collapses ~200 embedding calls into 1. Roughly 200x fewer round-trips for embeddings.

### Fix 2 — Combine entity extraction + conviction + speaker into ONE LLM call per chunk

Instead of two separate Claude calls per chunk, make one call that returns everything:

```
Analyze this financial transcript excerpt. Return ONLY this JSON:
{
  "entities": [
    { "name", "normalizedName", "entityType", "ticker"|null, "confidence", "mentionType" }
  ],
  "conviction": 0.0,
  "speakerGuess": "name or null"  // best guess from context, null if unclear
}

Rules:
- entityType ∈ ticker|company|person|investor|executive|topic|product|sector|fund
- Omit entities with confidence < 0.6
- conviction 0.0–1.0: declarative/quantified/directional = high; hedged/vague = low
- speakerGuess: infer from self-reference or addressing only; do NOT guess randomly

Transcript:
"""
{chunkText}
"""
```

This halves per-chunk LLM calls (2 → 1) and gives us speaker attribution (see below).

### Fix 3 — Parallelize the per-chunk LLM calls with bounded concurrency

The combined LLM calls are independent per chunk, so run them concurrently with a
concurrency cap (respects rate limits, avoids overwhelming the API):

```typescript
import pLimit from 'p-limit';
const limit = pLimit(8);  // 8 concurrent LLM calls

const results = await Promise.all(
  chunks.map(chunk => limit(() => analyzeChunk(chunk)))
);
```

```bash
npm install p-limit
```

**Net effect:** A 200-chunk episode goes from ~600 serial calls (~15 min) to
~1 batch embedding call + 200 parallel LLM calls at concurrency 8 (~2–3 min).

### Fix 4 — Retry with backoff

Bulk ingestion WILL hit rate limits. Wrap every external call:

```typescript
async function withRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const isRateLimit = e?.status === 429;
      if (i === max - 1 || !isRateLimit) throw e;
      const wait = Math.pow(2, i) * 1000 + Math.random() * 500; // exp backoff + jitter
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('unreachable');
}
```

---

## Speaker Attribution (Fixes the Dead-Filter Problem)

`youtube-transcript` provides no speaker labels, so the original spec's "filter by speaker"
was a feature the stack couldn't deliver.

**Phase 1 decision: Best-effort LLM speaker guessing, with honest UI degradation.**

- The combined LLM call (Fix 2 above) returns `speakerGuess` from contextual cues only
  (e.g. "I, Chamath, think..." or "Jensen, what's your view?"). It does NOT guess randomly.
- When `speakerGuess` is null (the common case), `speakerId` stays null.
- **UI rule:** The speaker filter only appears for a feed if at least 20% of its chunks have
  a resolved speaker. Otherwise hide the filter entirely. No dead controls.
- Real diarization remains a Phase 4 deliverable.

This is honest: we surface speaker data when we have it, and we don't promise a filter we
can't populate. Set expectations in the feed UI: show speaker name when known, "Unknown speaker"
otherwise.

---

## Revised API Contract

### POST /api/ingest/youtube  (now async)

**Request:** unchanged.

**Response (immediate — does NOT wait for ingestion):**
```json
{
  "jobId": "uuid",
  "status": "queued"
}
```

### GET /api/ingest/jobs/[jobId]  (new — for polling)

**Response:**
```json
{
  "jobId": "uuid",
  "status": "running",
  "progress": 64,
  "chunksTotal": 187,
  "chunksDone": 120,
  "episodeId": "uuid",
  "errorMessage": null
}
```

The feed/search/transcript GET endpoints are unchanged.

---

## Worker Entry Point

Add to `package.json`:
```json
{ "scripts": { "worker": "tsx lib/worker/index.ts" } }
```

> Use `tsx`, not `ts-node` — fewer config headaches with Prisma 5 + ESM.
> `npm install -D tsx`

```
lib/worker/
├── index.ts        # Poll loop: every 5s, claim 1 queued job, process it
├── processJob.ts   # The two-pass pipeline above
└── claim.ts        # Atomic job claim (SELECT ... FOR UPDATE SKIP LOCKED)
```

**Atomic claim (prevents two workers grabbing the same job):**
```sql
UPDATE "IngestionJob"
SET status = 'running', "startedAt" = now(), attempts = attempts + 1
WHERE id = (
  SELECT id FROM "IngestionJob"
  WHERE status = 'queued'
  ORDER BY "createdAt" ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` is the standard Postgres pattern for safe job claiming without a
queue service. It lets you run multiple workers later with zero code changes.

---

## Summary of Changes vs. Original Spec

| Issue | Original | Corrected |
|---|---|---|
| Pipeline ordering | Novelty before persistence (broken) | Two-pass: persist+embed+entities, THEN novelty |
| Novelty self-comparison | Not addressed | Exclude same-episode chunks from comparison |
| Novelty multi-entity | Silent | MAX across linked entities |
| Sync vs. worker | API route does all work (times out) | DB-backed job table + polling worker |
| Queue infrastructure | "avoid queues" vs. needs async | Postgres job table + FOR UPDATE SKIP LOCKED |
| Embedding calls | 1 per chunk (200/episode) | 1 batch call per episode |
| LLM calls | 2 per chunk serial | 1 combined call per chunk, concurrency 8 |
| Rate limits | Unhandled | Exponential backoff + jitter retry |
| Speaker attribution | Promised, unfillable | LLM best-effort + UI degrades honestly |
| Ingestion time/episode | ~15 min, times out on Vercel | ~2–3 min on a worker |
