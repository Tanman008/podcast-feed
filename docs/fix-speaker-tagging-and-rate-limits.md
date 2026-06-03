# Fix Runbook — Speaker Tagging Reliability + OpenAI Rate-Limit Safeguards

Audience: an implementing model/engineer. Two related defects (they share a root: OpenAI
calls that fail silently under load). Each section has **root cause → evidence → exact fix →
verification**. Apply Part 2 first — the global limiter + retry upgrade also reduces the speaker
failures, because most speaker drops are caused by rate-limit errors swallowed mid-pipeline.

> The two bugs are linked. When the worker gets rate-limited, `identifySpeakers` (which has **no
> retry**) throws, its result is swallowed into an empty map, and the whole episode gets zero
> speaker names. So "speakers don't always tag" and "I got rate limited" are frequently the *same
> incident*.

---

## PART 1 — Speaker tagging is not 100% reliable

### Pipeline recap (so you know the moving parts)
1. [transcriber.ts](src/lib/ingestion/transcriber.ts):70 — Deepgram returns `speaker: number`,
   stored as `speakerLabel: String(u.speaker)` → `"0"`, `"1"`, `"2"` per segment.
2. [chunker.ts](src/lib/ingestion/chunker.ts):71-84 — segments grouped into speaker turns;
   each `RawChunk` carries `speakerLabel`.
3. [speakerIdentifier.ts](src/lib/ingestion/speakerIdentifier.ts) — one LLM call (gpt-4o) maps
   diarization label → real name, returns `Record<label, name>`.
4. [processJob.ts](src/lib/worker/processJob.ts):183-186, 259-263 — for each chunk,
   `speakerName = speakerNames[chunk.speakerLabel] ?? null`, and `relevanceScore` (authority) is
   looked up by that resolved name.

There are **five** distinct failure modes in steps 3–4. Fix all of them.

### 1a. `identifySpeakers` has NO retry — a single 429/5xx zeroes the whole episode
[speakerIdentifier.ts](src/lib/ingestion/speakerIdentifier.ts):66-85 calls
`openai.chat.completions.create` **directly** (not via `withRetry`), and the outer `try/catch`
returns `{}` on *any* error. In [processJob.ts](src/lib/worker/processJob.ts):183-186 the call is
further wrapped in `.catch(() => ({}))`. So one transient rate-limit → empty map → **no chunk in the
episode gets a speaker name**. This is the single biggest cause of "not 100% of the time."

**Exact fix** — wrap the call in `withRetry` and log failures instead of silently returning `{}`:
```ts
import { withRetry } from '@/lib/utils/retry';
// ...
  try {
    const response = await withRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0,
      })
    );
    // ...parse...
  } catch (err) {
    console.error('[identifySpeakers] failed after retries:', (err as any)?.message);
    return {};
  }
```
Also change the caller in [processJob.ts](src/lib/worker/processJob.ts):183 to log when the result
is empty so this is visible in logs:
```ts
const speakerNames = await identifySpeakers(segments, { episodeTitle, sourceName: source?.name ?? undefined })
  .catch(err => { console.error(`[Job ${job.id}] identifySpeakers threw:`, err?.message); return {} as Record<string,string>; });
if (Object.keys(speakerNames).length === 0) {
  console.warn(`[Job ${job.id}] No speaker names resolved (${[...new Set(segments.map(s => s.speakerLabel))].length} labels present).`);
}
```

### 1b. Fragile JSON parsing — gpt-4o appends commentary after the object
[speakerIdentifier.ts](src/lib/ingestion/speakerIdentifier.ts):74-78 only strips markdown fences,
then `JSON.parse`. gpt-4o frequently emits `{...} \n\nNote: Speaker 3 is unclear.` — `JSON.parse`
throws on the trailing text → caught → `{}` → no names. (This is the **same class of bug** already
fixed in [engine.ts](src/lib/matching/engine.ts):393-405 with brace-depth extraction.)

**Exact fix** — reuse brace-depth extraction. Extract a shared helper to avoid a third copy:
```ts
// src/lib/utils/json.ts (new)
export function extractFirstJsonObject(raw: string): string | null {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start); // unbalanced — let JSON.parse surface the error
}
```
Then in `identifySpeakers`:
```ts
const jsonText = extractFirstJsonObject(response.choices[0]?.message?.content ?? '{}') ?? '{}';
const parsed = JSON.parse(jsonText) as Record<string, string | null>;
```
(Refactor [engine.ts](src/lib/matching/engine.ts):393-405 and
[entityExtractor.ts](src/lib/ingestion/entityExtractor.ts):144-148 to use the same helper — optional
but reduces drift.)

### 1c. Returned keys don't always match the diarization labels
The prompt example shows `{"0": "..."}`, but the model sometimes returns `{"Speaker 0": "..."}`,
`{"0 ": "..."}`, or `{"speaker_1": "..."}`. The lookup
`speakerNames[chunk.speakerLabel]` ([processJob.ts](src/lib/worker/processJob.ts):259) is an exact
string match on `"0"`, so any key drift silently yields `null`.

**Exact fix** — normalize keys to the bare label and intersect with the labels that actually exist:
```ts
const validLabels = new Set(labels); // labels = Object.keys(fromStart), the real Deepgram labels
const normalized: Record<string, string> = {};
for (const [k, v] of Object.entries(parsed)) {
  if (typeof v !== 'string' || !v.trim()) continue;
  const label = k.toLowerCase().replace(/^speaker[\s_]*/, '').trim(); // "Speaker 0" -> "0"
  if (validLabels.has(label)) normalized[label] = v.trim();
}
return normalized;
```

### 1d. Same name assigned to multiple labels (hallucinated merge)
The LLM sometimes labels two different diarization speakers with the *same* name (e.g. both
"0" and "2" → "Jensen Huang"). That mistags an entire speaker. Decide a policy:
- **Recommended:** if a name is assigned to >1 label, keep it only on the label with the most
  utterances (strongest evidence) and drop it from the others (leave them null/unresolved).
```ts
const byName = new Map<string, string[]>();
for (const [label, name] of Object.entries(normalized)) {
  (byName.get(name) ?? byName.set(name, []).get(name)!).push(label);
}
for (const [name, labs] of byName) {
  if (labs.length <= 1) continue;
  const keep = labs.sort((a, b) => (fromStart[b]?.length ?? 0) - (fromStart[a]?.length ?? 0))[0];
  for (const l of labs) if (l !== keep) delete normalized[l];
}
```

### 1e. Generic / junk names leak through
Reject obviously non-name outputs the model uses when guessing: `"Host"`, `"Guest"`, `"Unknown"`,
`"Speaker"`, `"Narrator"`, single characters, etc. Add a guard in the key-normalization loop:
```ts
const JUNK = /^(host|guest|unknown|speaker|narrator|interviewer|the host|n\/a|none)$/i;
if (JUNK.test(v.trim())) continue;
```

### Verification (Part 1)
Pick a known multi-speaker episode (All-In / Acquired / a named-guest interview). Re-run speaker
identification in isolation and confirm labels resolve:
```bash
npx tsx -e "
import './src/lib/worker/env';
import { db } from './src/lib/db';
(async () => {
  const ep = await db.episode.findFirst({ where:{ transcriptStatus:'completed' }, orderBy:{ createdAt:'desc' },
    select:{ id:true, title:true } });
  const chunks = await db.transcriptChunk.findMany({ where:{ episodeId: ep!.id },
    select:{ speakerLabel:true, speakerName:true } });
  const byLabel: Record<string,{name:string|null,n:number}> = {};
  for (const c of chunks) { const k=c.speakerLabel??'?'; byLabel[k] ??= {name:c.speakerName,n:0}; byLabel[k].n++; }
  console.log('EP', ep!.title);
  for (const [l,v] of Object.entries(byLabel)) console.log(\`  label=\${l} name=\${v.name ?? 'NULL'} chunks=\${v.n}\`);
})();" 2>/dev/null | grep -E 'EP|label='
```
**PASS IF:** most labels have non-null names, no name appears on >1 label, no junk names.
Re-ingest the episode (delete + re-run) 3× and confirm names resolve consistently — the retry +
parse fixes should make it deterministic where it was previously flaky.

---

## PART 2 — OpenAI rate-limit safeguards

### Root cause
Two problems compound:

**2a. No global concurrency cap across the worker.** The worker runs `MAX_CONCURRENT_JOBS = 3`
([worker/index.ts](src/lib/worker/index.ts):14) and each job fans out at
`LLM_CONCURRENCY = 8` ([optimization.ts](src/lib/config/optimization.ts):34) inside
`analyzeChunksBatch` ([entityExtractor.ts](src/lib/ingestion/entityExtractor.ts):229) **and** again
in `preExtractEpisodeClaims` ([engine.ts](src/lib/matching/engine.ts):1006). On top of that, after
each episode completes, `matchEpisodeAgainstAllInterests` runs an embed + per-uncovered-chunk LLM
call per interest. So peak in-flight OpenAI requests ≈ `3 jobs × 8` + embeddings + matching + speaker
+ authority calls = **easily 25–40 concurrent**, all against one account quota. That trips RPM/TPM
limits → 429s.

**2b. `withRetry` is too weak and ignores the server's backoff hint.**
[retry.ts](src/lib/utils/retry.ts): `maxAttempts = 3`, fixed exponential `1s/2s/4s`, and it never
reads OpenAI's `Retry-After` / `retry-after-ms` / `x-ratelimit-reset-*` headers. Under a sustained
limit, 3 short retries all fail inside the window and the call throws.

**2c. Several call sites bypass retry entirely:** `speakerIdentifier.ts` (Part 1a),
`speakerAuthority.ts`:61, `detectLanguage` ([entityExtractor.ts](src/lib/ingestion/entityExtractor.ts):203),
`retrieval/search.ts`:33, `chunks/[chunkId]/summary/route.ts`:68,
`interests/matches/[matchId]/gloss/route.ts`:65.

### Fix 2b — make `withRetry` honor server backoff (do this first; lowest risk)
Replace the backoff math in [retry.ts](src/lib/utils/retry.ts) so a 429 waits for the header value
when present, and allow more attempts for rate limits:
```ts
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 5;          // was 3
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs  = options?.maxDelayMs  ?? 60000;       // was 30000

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status;
      const isRateLimit   = status === 429;
      const isServerError = status >= 500;
      const isLastAttempt = attempt === maxAttempts - 1;

      if (!isRateLimit && !isServerError) throw error;   // never retry 4xx except 429
      if (isLastAttempt) throw error;

      // Honor the server's backoff hint when present.
      const headers = error?.headers ?? error?.response?.headers;
      const retryAfterMs =
        Number(headers?.get?.('retry-after-ms') ?? headers?.['retry-after-ms']) ||
        (Number(headers?.get?.('retry-after') ?? headers?.['retry-after']) * 1000) || 0;

      const expo = Math.pow(2, attempt) * baseDelayMs + Math.random() * 500;
      const delayMs = Math.min(Math.max(retryAfterMs, expo), maxDelayMs);

      console.warn(`[Retry] attempt ${attempt + 1}/${maxAttempts} (status=${status}); waiting ${Math.round(delayMs)}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}
```
> Note: header access differs by SDK version — the OpenAI Node SDK attaches `error.headers` (a plain
> object) on `APIError`. The code above handles both `Headers` (`.get`) and plain-object shapes.

### Fix 2a — add ONE global limiter all OpenAI calls pass through
Create a single shared module so the entire process has a hard ceiling on concurrent OpenAI
requests, independent of how many jobs/interests run. This is the real safeguard.
```ts
// src/lib/openai/client.ts (new)
import OpenAI from 'openai';
import pLimit from 'p-limit';
import { withRetry, RetryOptions } from '@/lib/utils/retry';

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Hard process-wide ceiling on concurrent OpenAI requests. Tune to your account tier.
// Default 8 keeps 3 jobs × 8 from becoming 24 simultaneous calls.
const GLOBAL = pLimit(parseInt(process.env.OPENAI_MAX_CONCURRENCY || '8', 10));

// Route EVERY chat/embedding call through this: global cap + retry-with-backoff.
export function openaiCall<T>(fn: () => Promise<T>, retry?: RetryOptions): Promise<T> {
  return GLOBAL(() => withRetry(fn, retry));
}
```
Then replace each `await withRetry(() => openai.X.create(...))` and each raw
`await openai.X.create(...)` with `await openaiCall(() => openai.X.create(...))`, importing `openai`
and `openaiCall` from `@/lib/openai/client` instead of constructing a local `new OpenAI(...)`.

**Call sites to migrate (all of them):**
| File | Line | Current |
|---|---|---|
| [entityExtractor.ts](src/lib/ingestion/entityExtractor.ts) | 129, 203 | `withRetry` / raw |
| [embedder.ts](src/lib/ingestion/embedder.ts) | 52 | `withRetry` |
| [engine.ts](src/lib/matching/engine.ts) | 176, 261, 380 | `withRetry` |
| [searchExpander.ts](src/lib/ingestion/searchExpander.ts) | 65 | `withRetry` |
| [speakerIdentifier.ts](src/lib/ingestion/speakerIdentifier.ts) | 67 | raw → wrap |
| [speakerAuthority.ts](src/lib/scoring/speakerAuthority.ts) | 61 | raw → wrap |
| [retrieval/search.ts](src/lib/retrieval/search.ts) | 33 | raw → wrap |
| [chunks/[chunkId]/summary/route.ts](src/app/api/chunks/%5BchunkId%5D/summary/route.ts) | 68 | raw → wrap |
| [interests/matches/[matchId]/gloss/route.ts](src/app/api/interests/matches/%5BmatchId%5D/gloss/route.ts) | 65 | raw → wrap |

Because the limiter is a module-level singleton, every job, interest match, and API route shares the
same 8-permit pool — the worker can no longer self-DDoS OpenAI regardless of `MAX_CONCURRENT_JOBS`.

### Fix 2d — lower the now-redundant per-batch concurrency (optional but recommended)
With a global cap of 8, the per-episode `LLM_CONCURRENCY` of 8 is fine, but set the env explicitly so
3 concurrent jobs don't each *try* to launch 8 (they'll queue on the global limiter, which is correct,
but lowering avoids long internal queues): set `LLM_CONCURRENCY=6` and `OPENAI_MAX_CONCURRENCY=8`–`12`
in the worker env, tuned to your OpenAI tier (Tier 1 ≈ 500 RPM; Tier 2+ can go higher). Document both
in `.env.example`.

### Verification (Part 2)
1. **Unit-check the backoff:** force a fake 429 and confirm it waits the header value:
```bash
npx tsx -e "
import { withRetry } from './src/lib/utils/retry';
let n=0;
withRetry(async () => {
  if (n++ < 2) { const e:any = new Error('rate'); e.status=429; e.headers={'retry-after':'1'}; throw e; }
  return 'ok';
}).then(r => console.log('RESULT', r, 'attempts', n));" 2>&1 | grep -E 'RESULT|Retry'
```
**PASS IF:** it logs two `[Retry]` waits of ~1000ms then `RESULT ok attempts 3`.
2. **Load test the global cap:** ingest 3+ episodes at once (queue several search/RSS jobs) and watch
worker logs. **PASS IF:** you see `[Retry]` lines recover (no fatal `429` job failures) and no job
fails with `Rate limit`. Before the fix, concurrent ingests produce `RateLimitError` job failures.
3. **Confirm no raw calls remain:**
```bash
grep -rn "openai\.\(chat\|embeddings\)\.create\|new OpenAI(" src --include="*.ts" | grep -v "lib/openai/client.ts"
```
**PASS IF:** every remaining hit is inside an `openaiCall(...)` wrapper (grep the surrounding lines).

---

## Suggested order
1. Part 2b (`withRetry` honors `Retry-After`) — 1 file, immediate resilience.
2. Part 1a (wrap `identifySpeakers` in retry + log) — fixes most speaker drops once 2b lands.
3. Part 1b–1e (parse + key-normalize + dedupe + junk filter) — speaker correctness.
4. Part 2a (global `openaiCall` limiter) + migrate all call sites — structural rate-limit fix.
5. Part 2d (tune concurrency envs, document in `.env.example`).

## Files touched (summary)
- `src/lib/utils/retry.ts` — Retry-After + more attempts (2b)
- `src/lib/utils/json.ts` *(new)* — shared brace-depth JSON extractor (1b)
- `src/lib/openai/client.ts` *(new)* — shared client + global limiter `openaiCall` (2a)
- `src/lib/ingestion/speakerIdentifier.ts` — retry, robust parse, key-normalize, dedupe, junk filter (1a–1e)
- `src/lib/worker/processJob.ts` — log empty/failed speaker resolution (1a)
- All OpenAI call sites in the table above — route through `openaiCall` (2a/2c)
- `.env.example` — document `OPENAI_MAX_CONCURRENCY`, `LLM_CONCURRENCY` (2d)

## Out of scope (note for later, do NOT fix here)
- Deepgram diarization itself sometimes splits one person across labels or merges two — that's an ASR
  limitation, not the name-tagging layer the user asked about. If pursued later, consider Deepgram's
  `diarize_version` tuning or a post-pass that merges labels with near-identical speaker embeddings.
- The combined extraction prompt in [entityExtractor.ts](src/lib/ingestion/entityExtractor.ts):96 does
  not request `horizon`/`speakerRole`, and the mapper at lines 166-177 drops them, so Pass-1 claims
  always fall back to the heuristic horizon and null speakerRole. Tracked separately.
