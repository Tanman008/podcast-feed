# Ingestion Verification Runbook

**Audience:** an agent (e.g. Claude Sonnet) running inside VSCode with terminal access, asked to
confirm the ingestion pipeline is working end-to-end. Self-contained — assumes no prior context.

**Goal:** prove that an episode can be (re)ingested and flows correctly through every stage:
`enqueue → claim job → transcribe → chunk → embed → extract claims → score → match to interests`,
and that the output claims are sane (verbatim, typed, with horizon/speakerRole on new ingests).

> Run the steps in order. Each step has a **PASS IF** gate. Stop and report at the first failure,
> quoting the actual output. Do not "fix" the pipeline unless explicitly asked — this is a check.

---

## 0. Environment preflight

```bash
# DB + OpenAI keys load from .env.local. Confirm they exist (presence only, never print values).
grep -cE 'DATABASE_URL' .env.local
grep -cE 'OPENAI_API_KEY' .env.local
# Podcast Index keys may be absent locally (search still works via keyless iTunes).
grep -cE 'PODCAST_INDEX_API_KEY' .env.local || true
```

**PASS IF** `DATABASE_URL` and `OPENAI_API_KEY` each return `1`. If `DATABASE_URL` is missing, stop —
nothing downstream can run.

---

## 1. Corpus health snapshot (baseline)

```bash
npx tsx scripts/inventory.ts 2>/dev/null | grep -vE 'prisma:query|injected env'
```

Record these numbers — they are the "before" baseline:
- total episodes + how many `completed` vs `pending`/`failed`
- total chunks, total claims, **claim coverage %** (chunks with ≥1 claim)
- claims-by-type distribution
- per-interest match counts

**PASS IF** the snapshot prints without error and shows ≥1 `completed` episode with chunks and claims.
**RED FLAGS:** coverage <15% (extraction under-producing); many `pending` episodes that never become
`completed` (worker not running or jobs stuck); off-enum claim types appearing in large numbers
(the prompt enum isn't being respected).

---

## 2. Worker is alive

The worker is what actually processes jobs. The API only enqueues.

```bash
# Start it in the background if it isn't already running. Leave it running for steps 3–5.
npm run worker
```

Expected startup log lines:
```
[Worker] Starting ingestion worker...
[Worker] Job poll: every 5s | RSS poll: every 30min | Max concurrent: 3
```

**PASS IF** the worker logs the poll loop and does NOT crash on boot. If it logs
`Cleaning up N stale job(s)` that's normal (orphans from a prior run).

---

## 3. Reingestion test (the core check)

Pick one already-`completed` episode, delete its derived data, and let the worker rebuild it. This
exercises the full pipeline against known-good input without depending on external audio fetching.

> If you'd rather test a brand-new ingest instead, skip to **Step 4** (search) — that covers
> discovery + download + the same pipeline. Step 3 isolates the *processing* stages.

```bash
# 3a. Choose a target episode id (smallest completed episode keeps the test fast).
npx tsx -e "
import './src/lib/worker/env';
import { db } from './src/lib/db';
(async () => {
  const e = await db.episode.findFirst({
    where: { transcriptStatus: 'completed' },
    orderBy: { chunks: { _count: 'asc' } },
    select: { id: true, title: true, _count: { select: { chunks: true } } },
  });
  console.log('TARGET', e?.id, '|', e?._count.chunks, 'chunks |', e?.title);
  await db.\$disconnect();
})();
" 2>/dev/null | grep TARGET
```

Note the `TARGET <episodeId>`.

```bash
# 3b. Re-run claim extraction for that episode (idempotent — skips chunks that already have claims).
#     This is the cheapest reingestion check: it re-decomposes chunks → Claims via the LLM.
npx tsx -e "
import './src/lib/worker/env';
import { db } from './src/lib/db';
import { preExtractEpisodeClaims } from './src/lib/matching/engine';
(async () => {
  const id = process.argv[1];
  const before = await db.claim.count({ where: { chunk: { episodeId: id } } });
  const n = await preExtractEpisodeClaims(id);
  const after = await db.claim.count({ where: { chunk: { episodeId: id } } });
  console.log('CLAIMS before=' + before, 'newlyExtracted=' + n, 'after=' + after);
  await db.\$disconnect();
})();
" <episodeId> 2>/dev/null | grep -E 'CLAIMS|extractAllClaims'
```

**PASS IF** the run completes without throwing and `after >= before`. On a fresh episode (no prior
claims) `newlyExtracted` should be a healthy fraction of chunk count (roughly 30%+). On an
already-extracted episode `newlyExtracted` may be 0 — that's correct idempotency, not a failure.

To force a true from-scratch reingestion of one episode (destructive — only on a test target):

```bash
npx tsx -e "
import './src/lib/worker/env';
import { db } from './src/lib/db';
(async () => {
  const id = process.argv[1];
  await db.claim.deleteMany({ where: { chunk: { episodeId: id } } });
  console.log('Deleted claims for', id, '— now re-run 3b');
  await db.\$disconnect();
})();
" <episodeId> 2>/dev/null
# then re-run 3b; expect newlyExtracted > 0
```

---

## 4. Search discovery check (finds the right videos)

Confirms the rewritten discovery (iTunes-primary + relevance filter + identity-safe C-suite). Uses
keyless iTunes, so it works even without Podcast Index keys.

```bash
npx tsx scripts/test-discovery.ts NVIDIA 2>/dev/null | grep -v 'injected env'
```

**PASS IF** the NVIDIA case returns multiple real episodes whose titles are about NVIDIA
(Bloomberg Tech, Acquired, NVIDIA AI Podcast, etc.).
**FAIL IF** it returns 0 episodes, or returns clearly off-topic shows (the relevance filter is broken).

Identity-safety spot check — the KO case must NOT contain the UGG boots founder story:

```bash
npx tsx scripts/test-discovery.ts 2>/dev/null | grep -A14 'Coca-Cola'
```
**PASS IF** every Coca-Cola result is actually about Coca-Cola (no "UGG", no unrelated "Brian Smith").

---

## 5. Claim quality + scoring delivery

```bash
# Inspect extracted claims for the target episode with the score component breakdown.
npm run inspect-claims -- --episode <episodeId> --debug 2>/dev/null | grep -vE 'prisma:query'
```

**PASS IF**, eyeballing the rows:
- highlights are **verbatim** transcript text (not paraphrased/synthesized)
- `claimType` is always one of the canonical 8: `unit_economics transaction growth thesis position
  competitive valuation guidance` (no `market insight`, `cost_structure`, etc.)
- numeric claims carry a `numbers` line
- no junk fragments like "Customers like the product." dominating

```bash
# End-to-end scoring/delivery: re-score one interest and confirm forward-looking ranks above
# retrospective earnings recitation. (Deletes + rebuilds that interest's matches — expected.)
npx tsx scripts/validate-scoring.ts NVDA 2>/dev/null | grep -vE 'prisma:query|SELECT|FROM|JOIN|WHERE|ORDER|LIMIT|tc\.|e\.|AND |1 - '
```

**PASS IF** in the AFTER block:
- a pure earnings recitation ("... blew out earnings, $XXB revenue up XX% year over year") is NOT #1
  (it should be tagged `hor=retro` and pushed down, or dropped)
- top results lean `hor=forwa` / `hor=timel` and name the searched entity (`ew=1.00`)
- off-entity noise (claims about unrelated companies) is absent from the top

---

## 6. Failure-signature cheat sheet

| Symptom | Likely cause | Where to look |
|---|---|---|
| Episodes stuck `pending`, never `completed` | worker not running, or job throwing | worker logs; `IngestionJob.status`/`errorMessage` |
| Job goes `failed` immediately | audio fetch / transcription error | `IngestionJob.errorMessage`; `src/lib/worker/processJob.ts` |
| `completed` but 0 chunks | chunker/transcript empty | `src/lib/ingestion/chunker.ts`, `transcriber.ts` |
| Chunks but very few claims | extraction prompt rejecting too hard | `extractAllClaims` in `src/lib/matching/engine.ts` |
| Off-enum claim types in inventory | LLM ignoring enum (new claims) | `normalizeClaimType` covers scoring; check prompt |
| Search returns 0 / wrong shows | discovery or relevance filter | `src/lib/ingestion/searchIngestion.ts`, Step 4 |
| Earnings recitation ranks #1 | horizon multiplier not applied | `horizonMultiplier` / `heuristicHorizon` in engine.ts |
| All matches `ew=0.10` for a ticker | ticker→company expansion failed | `lookupTicker`, `matchInterestAgainstEpisodes` |

---

## 7. Cleanup

- Stop the background worker (Ctrl-C / kill the process) if you started it only for this check.
- Steps that delete data only touch the chosen test `<episodeId>` and the re-scanned interest's
  `InterestMatch` rows (which any re-scan rebuilds). No source/episode rows are deleted.
- `validate-scoring.ts` already rebuilt the NVDA matches; no further action needed.

---

## What "working properly" means (summary gate)

Report **PASS** only if ALL hold:
1. Worker boots and polls without crashing.
2. Reingestion of a target episode produces claims without error (Step 3).
3. Search discovery returns on-topic episodes and rejects same-name impostors (Step 4).
4. Claims are verbatim, canonically typed, non-fragment (Step 5).
5. Scoring delivers forward-looking/on-entity claims above retrospective earnings recitation (Step 5).

Otherwise report the first failing step with its raw output.
