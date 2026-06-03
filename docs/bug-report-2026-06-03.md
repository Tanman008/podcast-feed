# Bug Report — Investigation 2026-06-03

Audience: an implementing model/engineer. Each bug has root cause, evidence, and an
**exact fix** (with a backup approach where the right call is a judgment one). Nothing in
here has been changed yet — this is diagnosis only.

Key architectural fact to hold in your head: there are **two parallel, unlinked systems**.
1. **Interests** — `UserInterest` + `InterestMatch`. Added via the "+ Monitor" button on
   `/interests` (the home page redirects here). Creates a `UserInterest` only. `backfillInterest`
   matches the term against the **already-ingested corpus**. It NEVER fetches new podcasts and
   NEVER creates a `Source`.
2. **Search subscriptions** — a `Source` with `sourceType='search'`, `following=true`. Added via
   the "Search" tab of `IngestionForm` (`POST /api/ingest/search`). Discovers + downloads episodes
   and re-polls periodically. Shows on `/channels`.

Most of the user's pain comes from these two being disconnected.

---

## Bug 1 — Following a company doesn't show in "Channels followed"

**Status: confirmed (live DB).** Of 8 `sourceType='search'` sources, **7 are `following=false`**
and therefore invisible on `/channels` (which filters `where: { following: true }`). Examples:
`NVDA` (9 episodes, following=false), `ASML` (2 eps, false), `Satya Nadella` (false). Only the
newest, `KO`, is `following=true` and visible.

There are two distinct defects feeding this symptom:

### 1a. Re-subscribing never re-follows an existing search source
[src/app/api/ingest/search/route.ts](src/app/api/ingest/search/route.ts) `upsertSearchSource()`:

```ts
const existing = await db.source.findFirst({ where: { url: canonicalUrl }, select: { id, name } });
if (existing) return existing;   // ← returns as-is; does NOT set following:true
```

If a user unfollows a search source (the only thing that sets `following=false` is
[src/app/api/channels/[sourceId]/route.ts](src/app/api/channels/%5BsourceId%5D/route.ts), the
DELETE/unfollow), then later searches the same term again, the source is found by URL and returned
**unchanged** — it stays `following=false`, stays off `/channels`, yet episodes are still queued.
That's exactly the observed state (search sources with episodes but following=false).

**Exact fix:** when the source already exists, re-activate it.
```ts
if (existing) {
  const reactivated = await db.source.update({
    where: { id: existing.id },
    data: { following: true, searchQuery: query },   // refresh query too
  });
  return { id: reactivated.id, name: reactivated.name };
}
```

### 1b. The primary "follow" action (Monitor / Interest) creates no channel at all
The home page redirects to `/interests`. The prominent action there is "+ Monitor", which calls
`POST /api/interests` → creates a `UserInterest` only. A user who "follows NVDA" this way will
**never** see it under Channels, and — worse — no discovery/ingestion is ever triggered for it
(see Bug 3). This is almost certainly the user's mental model of "follow a company".

**Decision required — pick one:**
- **(Recommended) Unify the follow action.** When an interest is created, also create/reactivate a
  matching search subscription so the company appears in Channels *and* pulls fresh episodes. In
  `POST /api/interests`, after creating the interest, call the same logic as
  `POST /api/ingest/search` (extract `expandSearchTerm` + `upsertSearchSource` +
  `fetchSearchEpisodes` into a shared helper, e.g. `src/lib/ingestion/subscribe.ts`, and call it
  from both routes). This also fixes the "not enough hits for a brand-new interest" half of Bug 3.
- **(Backup) Surface interests on /channels read-only.** Less invasive: have `/channels` (or a new
  "Following" section) also list `UserInterest` rows so the user at least sees what they follow.
  Does not fix the no-new-episodes problem.

**Also fix the read filter (defensive):** even after 1a, historical sources that are
`following=false` won't reappear. If desired, a one-time migration to set
`following=true where sourceType='search'` will restore the 7 orphaned subscriptions. Confirm with
the user before bulk-updating.

---

## Bug 2 — Following a company downloads duplicate podcasts

**Status: confirmed (live DB).** The NVDA search source has the *same* episode twice:
`externalId=1000768453243` and `externalId=1000768453478` — same title
("Nvidia CEO Jensen Huang & Dell CEO Michael Dell…"), same `publishedAt` (2026-05-18), same source.
Both got downloaded and transcribed. Root causes:

### 2a. iTunes trackId vs Podcast Index episode-id are different ID spaces
In [src/lib/ingestion/searchIngestion.ts](src/lib/ingestion/searchIngestion.ts):
- `itunesSearchEnriched()` sets `id: ep.trackId` (an iTunes track id).
- `fetchByFeedTerms()` returns PI episodes with `id = PI episode id`.
- `fetchSearchEpisodes()` dedups by `ep.id` (`byId`) and by `ep.enclosureUrl` (`seenUrls`).

The same underlying episode can arrive once as an iTunes track and once as a PI episode with
**different `id`s** and **different enclosure URLs** (iTunes `episodeUrl` is frequently a redirect
wrapper that differs from the PI `enclosureUrl`), so neither dedup key catches it. iTunes itself
also returns the same episode under multiple `trackId`s when a show is in multiple feeds — exactly
the `…453243` / `…453478` pair seen.

**Exact fix — add a content-identity dedup key** in `fetchSearchEpisodes()` before returning, in
addition to id/url:
```ts
function epKey(ep: PIEpisode): string {
  // Normalize title + published-day as a stable cross-source identity.
  const t = (ep.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const day = ep.datePublished ? Math.floor(ep.datePublished / 86400) : 0;
  return `${t}::${day}`;
}
```
Track a `seenKeys = new Set<string>()` alongside `byId`/`seenUrls` in the `add()` closure and skip
when `seenKeys.has(epKey(ep))`. Also normalize enclosure URLs before comparing (strip query strings
and known redirect prefixes) so `seenUrls` catches more.

### 2b. No cross-source dedup at ingest time for RSS/search jobs
[src/lib/ingestion/deduplication.ts](src/lib/ingestion/deduplication.ts) `checkIsDuplicate()` only
checks `(sourceId, externalId)` — same source. The `Episode` table's only uniqueness is
`@@unique([sourceId, externalId])` (see [prisma/schema.prisma](prisma/schema.prisma):56). And
`checkIsDuplicate` is only called in the **manual** ingest branch of
[src/lib/worker/processJob.ts](src/lib/worker/processJob.ts) (the `preExisting === null` path) — RSS
and search jobs skip it entirely. So the same episode discovered by two different subscriptions
(e.g. an "NVDA" search and a "Jensen Huang" search, or a search + the show's RSS channel) is
downloaded and transcribed once per source.

**Exact fix (the higher-value one):** before enqueuing in
[src/app/api/ingest/search/route.ts](src/app/api/ingest/search/route.ts) and
[src/lib/worker/searchMonitor.ts](src/lib/worker/searchMonitor.ts), check for an already-ingested
episode with the same audio URL across **all** sources, not just this one:
```ts
const dupe = await db.episode.findFirst({
  where: { /* match on a normalized enclosure URL or (title, publishedAt) */ },
  select: { id: true, transcriptStatus: true },
});
if (dupe && dupe.transcriptStatus === 'completed') continue; // skip download; optionally link
```
This requires either (a) persisting a normalized `audioUrl`/`enclosureHash` column on `Episode` to
match against (recommended — add `enclosureUrl String?` + index, set it on create), or (b) matching
on `(title, publishedAt::date)`.

**Backup / cheap mitigation if you don't want a schema change:** add the `epKey` dedup from 2a (kills
the within-source dupes, which is what the live data shows) and accept that genuinely cross-source
dupes remain until a schema field is added.

> Note: dedup that *skips* downloading is good, but if you want the same episode to appear under
> multiple interests/feeds, dedup should still let multiple `InterestMatch` rows point at the one
> `Episode`. Matching already works off the shared corpus, so skipping the duplicate *download* does
> not reduce feed coverage.

---

## Bug 3 — Not enough hits / match-quality barrier too high

**Status: confirmed.** The single `NVDA` interest has 13 matches despite 15 claims whose
`primarySubject` is literally "nvidia" (plus more that mention it). The scoring pipeline in
[src/lib/matching/engine.ts](src/lib/matching/engine.ts) `matchInterestAgainstEpisodes()` over-filters.
Ranked by impact:

### 3a. `MAX_CLAIMS_PER_SUBJECT = 3` caps the searched entity itself (biggest offender)
[engine.ts](src/lib/matching/engine.ts):924. The per-primarySubject cap is applied **globally across
the whole feed**, including to the company you searched for. For an "NVDA" feed almost every good
claim has `primarySubject="NVIDIA"`, so **the feed can contain at most 3 claims about NVIDIA, ever.**
That single line is the dominant cause of "not enough hits". The cap's intent (limit a *secondary*
entity like OpenAI from flooding an MSFT feed) is reasonable, but it must not apply to the searched
entity.

**Exact fix:** exempt the searched entity from the subject cap.
```ts
// near the top, after expandedTokens is built:
const searchedSubject = (s: string | null) =>
  !!s && expandedTokens.some(t => matchesToken(s, t));

// in the write loop:
if (subject && !searchedSubject(subject)) {        // ← only cap NON-searched subjects
  const subjectHits = perSubjectCount[subject] ?? 0;
  if (subjectHits >= MAX_CLAIMS_PER_SUBJECT) continue;
  perSubjectCount[subject] = subjectHits + 1;
}
```
**Backup:** raise `MAX_CLAIMS_PER_SUBJECT` to ~8–10 and only apply it in the multi-episode/backfill
path. Less precise but quick.

### 3b. Compounding multiplicative gates crush absolute scores
Final score (engine.ts:854) multiplies up to seven sub-1.0 factors:
```
score = investmentScore × claimTypeMultiplier × horizonMult × authorityMult
        × (1 - platitudePenalty×0.5) × relevanceGate × entityGate
```
- `investmentScore` is a weighted sum that realistically lands ~0.25–0.45.
- `relevanceGate = interestMatch^1.5` (engine.ts:850). With a typical `combinedScore ≈ 0.5`, this is
  `0.5^1.5 ≈ 0.35` — a 65% haircut on *every* claim.
- `entityGate` is `0.10` for the 0.18–0.25 relevance tier (engine.ts:852).
- `claimTypeMultiplier` is `0.8` for `thesis` — the most common "ideas" type (engine.ts:60).

Stacked, a perfectly on-topic forward NVIDIA thesis lands around
`0.35 × 0.8 × 1.30 × 1.0 × 1.0 × 0.35 × 1.0 ≈ 0.13`. The UI quality labels
([InterestFeed.tsx](src/components/InterestFeed.tsx):96) call 0.13 "Fair", and anything the user
slides above "Good" (0.18) drops nearly everything. So the *barrier feels high* because real scores
rarely clear the upper slider notches.

**Exact fix (tune, don't rip out):**
- Soften the relevance gate exponent: `Math.pow(interestMatch, 1.5)` → `Math.pow(interestMatch, 1.1)`
  (or `Math.max(0.5, interestMatch)` as a floor) so on-topic claims aren't double-penalized
  (vector similarity already gated them in).
- Raise the bottom `entityGate` tier from `0.10` to ~`0.35` so the 0.25–0.50 band isn't crushed.
- Recalibrate the UI labels in [InterestFeed.tsx](src/components/InterestFeed.tsx):96
  (`matchQualityLabel`) to the score distribution that actually results, OR normalize scores to a
  0–1 range before display. After changing weights, re-run `scripts/validate-scoring.ts NVDA` and set
  the Best/Strong/Good/Fair thresholds to real percentiles.

**Important workflow note:** scoring changes only take effect after a re-scan. Run
`npm run reindex-interests` (or per-interest `scripts/validate-scoring.ts`) — stored `InterestMatch`
rows are not recomputed automatically except for newly-ingested episodes.

### 3c. A brand-new interest only matches the existing corpus
`backfillInterest` → `matchInterestAgainstEpisodes(id, term, null)` searches only already-ingested
chunks. If nothing about the company has been ingested, the new interest shows ~zero hits regardless
of scoring. This is the same root as Bug 1b and is fixed by the "unify follow" change there (creating
the interest also kicks off discovery/ingestion).

### 3d. (Secondary) `ENTITY_RELEVANCE_FLOOR = 0.18` + claim pre-filter
engine.ts:805 drops semantic-only claims, and the claim load filter
(`completeness ≥ 0.4, specificity ≥ 0.2`, engine.ts:771) plus the `MATCH`-time
`completeness ≥ 0.5` filter (engine.ts:409) trim more. These are individually defensible; revisit
only if 3a/3b don't restore enough volume.

---

## Bug 4 — All podcast dates show the ingestion date

**Status: confirmed (root caused).** The `Episode.publishedAt` values in the DB are **correct**
(e.g. 2026-05-18, 2025-02-19) — so ingestion stores the right date. The bug is in the **display
layer** of the Episodes page.

[src/app/episodes/page.tsx](src/app/episodes/page.tsx):86 renders:
```tsx
<span>{new Date(ep.createdAt).toLocaleDateString(...)}</span>   // ← createdAt = ingestion time
```
Every episode was ingested in the last day or two, so they all show ~today. It should show
`ep.publishedAt`.

**Exact fix:**
```tsx
<span>{new Date(ep.publishedAt ?? ep.createdAt).toLocaleDateString('en-US',
  { month: 'short', day: 'numeric', year: 'numeric' })}</span>
```
(Falling back to `createdAt` only when `publishedAt` is null.)

**Watch for a second instance of the same class of bug** on the deployed worker:
`fetchSearchEpisodes` → `itunesSearchEnriched` falls back to iTunes `releaseDate` whenever PI
enrichment fails (`datePublished: piEp?.datePublished ?? new Date(ep.releaseDate)…`,
[searchIngestion.ts](src/lib/ingestion/searchIngestion.ts):153). PI enrichment fails whenever the
**Podcast Index API keys are absent** — and they are absent in `.env.local` locally. If they are
also unset on the Railway worker, every search-ingested episode relies on the iTunes `releaseDate`,
which iTunes drifts to the episode's last-modified date. Locally this still produced correct dates,
but **verify `PODCAST_INDEX_*` keys are set on Railway** to be safe.

---

## Additional issues found during the sweep (not in the user's list)

### A. "Open in YouTube" links are broken for all podcast episodes
[InterestFeed.tsx](src/components/InterestFeed.tsx):486 builds
`https://youtu.be/${match.episode.externalId}?t=…`. For `search`/`podcast` sources, `externalId` is
an iTunes/PI numeric id (e.g. `1000768453243`), not a YouTube video id, so every ▶ timestamp link and
the ↗ header link is a dead YouTube URL. Only legacy `youtube`-source episodes work.
**Fix:** store/serve the episode's real audio/web URL and link to that (with `?t=` only for
true YouTube sources), or gate the YouTube link on `source.platform === 'youtube'` and otherwise link
to the enclosure URL / a transcript-modal deep link.

### B. New ingests don't persist `horizon` / `speakerRole` from Pass 1
[processJob.ts](src/lib/worker/processJob.ts):274–291 creates claims from the combined analysis pass
**without** `horizon` or `speakerRole` (the `db.claim.create` omits both fields). Only Pass 1.5
(`preExtractEpisodeClaims`, which runs `extractAllClaims`) sets them — and Pass 1.5 only processes
chunks that got **zero** claims in Pass 1. So any chunk that produced a claim in Pass 1 stores
`horizon=null`/`speakerRole=null` and falls back to the heuristic at score time. The memory note that
"speakerRole/horizon populate on new ingests" is therefore only half true.
**Fix:** either pass these fields through in the processJob `claim.create` (the `ExtractedClaim`
objects from `analyzeChunksBatch` already carry them — see
[entityExtractor.ts](src/lib/ingestion/entityExtractor.ts)), applying `normalizeHorizon` /
`normalizeSpeakerRole`, or stop extracting claims in Pass 1 and let Pass 1.5 own all claim creation.

### C. `Source.following` defaults to `true`
[prisma/schema.prisma](prisma/schema.prisma):27. Any `Source` created without explicitly setting
`following` (e.g. a future manual-ingest path) will silently appear on `/channels`. Today the manual
paths set it, but the default is a latent footgun — consider `@default(false)` and setting it
explicitly where a follow is intended.

### D. Episodes page empty-state copy is stale
[episodes/page.tsx](src/app/episodes/page.tsx):60 still says "Submit a YouTube URL on the home page" —
the product no longer ingests via YouTube URLs from the home page. Cosmetic.

---

## Suggested fix order
1. **Bug 4** (one-line display fix) + **Bug 3a** (subject-cap exemption) — highest impact / lowest
   risk; together they make the feed visibly fuller with correct dates.
2. **Bug 1a** (re-follow on re-subscribe) + the orphaned-source backfill (with user OK).
3. **Bug 3b** (gate tuning) — requires a re-scan and threshold recalibration; do it deliberately.
4. **Bug 1b / 3c** (unify follow→subscribe) — the real structural fix; larger change.
5. **Bug 2** (dedup) — add `epKey` first (cheap), then the cross-source enclosure dedup if a schema
   field is acceptable.
6. Extras A–D as cleanup.

After any engine.ts change: `npm run reindex-interests` (or `scripts/validate-scoring.ts <TERM>`),
because stored `InterestMatch` rows don't recompute on their own.
