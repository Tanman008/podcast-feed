# Feed Algorithm Audit
**Date:** 2026-06-02  
**Episode used:** Satya Nadella — Microsoft's AGI Plan & Quantum Breakthrough (Dwarkesh Patel, 77m)  
**Interest used:** MSFT

---

## 1. What an investor is actually trying to do

An investor following a stock in a podcast feed has a specific mental model:

> "There are maybe 50 hours of podcast content per week across the shows I care about. Most of it is irrelevant to my positions. I want a daily digest that surfaces the 3-5 moments where someone said something that could change my view: a specific number I didn't know, a directional thesis I hadn't heard, a signal that something is accelerating or breaking down. I don't want summaries. I want the actual words, attributed to the person who said them."

The key investor-relevant claim types in order of signal value:

1. **Quantified guidance/growth** — "AI revenue is $13B and compounding 10x over 4 years" → directly updates your model
2. **Competitive positioning from insiders** — Satya on why Azure won't be winner-take-all → structural thesis
3. **Product capability claims** — new hardware milestone, new feature shipping → track competitive moat
4. **Valuation framing** — "SaaS industry worth hundreds of billions to trillions" → addressable market context
5. **Strategic intent signals** — what the CEO is prioritizing/betting on → forward direction

What investors do NOT need in a focused feed:
- Revenue numbers from completely unrelated companies (NVIDIA earnings in an MSFT feed)
- Generic AI hype commentary with no company attribution
- Job market discourse, unless it's about specific workforce actions at the company

---

## 2. Ideal investor claims from the Satya episode

My read of the 10 most investable claims from the transcript:

**#1 — Revenue trajectory (growth)**
> "Your yearly revenue from AI is $13,000,000,000. But if you look at your year on year growth on that, in, like, four years, it'll be, you know, 10x that. You'll have $130,000,000,000 in revenue from AI if the trend continues."

Numbers: $13B current, $130B in 4 years. Directly actionable for financial models.

**#2 — Hyperscale moat thesis (competitive)**
> "I remember in even in the early days when I was getting into Azure, I mean, Amazon had a very significant lead, and people would come to me, and investors would come to me and say, Oh, it's game over. You'll never make it. Amazon's it's winner take all. Structurally, hyperscale will never be a winner take all, because buyers are smart."

Satya explicitly articulating Azure's competitive moat and why multi-cloud dynamics protect Azure's position.

**#3 — Enterprise buyer structure (thesis)**
> "But anything that the buyer is a corporation, an enterprise, an IT department, a beat, they will want multiple suppliers."

Explains WHY hyperscale isn't winner-take-all — enterprise procurement behavior.

**#4 — Compute-intelligence relationship (thesis)**
> "The fundamental thing is if you sort of go back to even how Sam and others describe it, I mean, like, if, you know, intelligence is log of compute. Whoever can do lots of compute is a big winner."

Satya's strategic justification for Azure's CapEx thesis — intelligence scales with compute, Microsoft has the compute.

**#5 — SaaS total addressable market (valuation)**
> "SaaS as an industry might be worth hundreds of billions to trillions of dollars a year depending on how you count."

Framing of Microsoft's SaaS revenue opportunity in absolute terms.

**#6 — Quantum breakthrough milestone (growth/product)**
> "So we have also got some fantastic breakthroughs on error correction. And that's what is allowing us, even on a neutral atom, and in ion trap quantum computers, to build these 20 plus. We have, what, 20 — I think the last thing that we announced was 24 logical qubits."

Specific milestone: 24 logical qubits. Checkable fact, competitive positioning vs IBM/Google Quantum.

**#7 — Gaming IP as AI training moat (thesis)**
> "Tens, hundreds of billions of dollars in building up Microsoft gaming and acquiring IP. And, in retrospect, if you can just merge every all of this data into one big model that can give you this experience..."

Framing the Activision/Xbox acquisition as AI training data play — not yet priced in thesis.

**#8 — Model commoditization thesis (competitive)**
> "I just don't see it [winner-take-all models] because this, by the way, is the other thing I've learned, is being very good at understanding what are winner take all markets and what are not winner take all markets is, in some sense, everything."

Satya's view that model commoditization is good for infrastructure providers (Azure) over model labs.

**#9 — Copilot as workflow change agent (growth)**
> "I do think the SaaS applications that exist today, right, these CRUD applications, are gonna fundamentally be changed because the business logic will go more into this agentic tier."

Forward view on how Copilot will re-architect enterprise SaaS (Microsoft's existing base).

**#10 — Quantum computing transistor moment (thesis)**
> "We like the analogy of thinking of this as the transistor moment of quantum computing, where we effectively have a new phase of matter, effectively."

Specific positioning claim (Majorana Zero chip as category-defining technology).

---

## 3. What the algorithm produced before fixes

### Baseline state
**MSFT interest, all 61 matches — entity weight distribution:**
- 100% of matches had `entityWeight = 0.10` (the "entity not found" baseline)
- 0 matches from the Satya Nadella episode
- Top matches: NVIDIA earnings ($81B), Starlink revenue, SpaceX fundraising, Anthropic compute costs

**Root cause cascade:**

```
Source.following = false (Dwarkesh Patel)
  → vectorSearch filtered: AND s."following" = true
  → Satya episode entirely excluded
  → 0 MSFT matches from the most relevant MSFT episode in the corpus
```

Additionally, even for content that DID surface:
- Entity gate threshold was `entityRelevance > 0.05 ? 1.0 : 0.35` — essentially inactive
- All claims with semantic-only entity match (ew=0.10, eco=0.15) passed the gate at 1.0
- Result: feed sorted by materiality + novelty with no entity filter → general big-tech revenue claims

**The feed was a "highest-materiality big-tech claims" feed, not an MSFT feed.**

---

## 4. Root causes identified

### Bug 1 (Critical): `following=true` filter in vector search
**File:** `src/lib/matching/engine.ts`, vectorSearch queries  
**Problem:** Both vector search queries had `AND s."following" = true`. The Dwarkesh Patel source was not marked as following (it was a single manually-ingested episode), so its entire episode library was excluded from all interest matching.  
**Impact:** The single most valuable MSFT episode in the corpus had zero representation in the MSFT feed.

### Bug 2 (Critical): Ticker tokens not expanded to company names
**File:** `src/lib/matching/engine.ts`, `matchInterestAgainstEpisodes`  
**Problem:** `parseTerm("MSFT")` produces `tokens: ["MSFT"]`. The `getSubsidiaries` function checks `"microsoft".includes("msft")` → false. No subsidiaries activated. Entity weight for all claims stayed at the semantic baseline (0.10).  
**Impact:** For any ticker-based interest (NVDA, AAPL, MSFT), the entire entity matching subsystem was inactive. No subsidiary matching (Azure, GitHub, Copilot). No primary subject matching against company name.

### Bug 3 (Critical): Claim extraction has no speaker/episode context
**File:** `src/lib/matching/engine.ts`, `extractAllClaims`  
**Problem:** Chunks are extracted in isolation. When Satya Nadella says "your yearly revenue from AI is $13B", the LLM assigns `primarySubject: "AI revenue"` because it doesn't know the speaker is Microsoft's CEO. Without "Microsoft" in the primarySubject, the entity weight stays at 0.10 even after the ticker expansion fix.  
**Impact:** All strategic claims from CEO/executive interviews get attributed to generic subjects (the industry, a concept) rather than the company. The most signal-dense content in the corpus becomes invisible to entity matching.

### Bug 4 (Major): `preExtractEpisodeClaims` never called from ingestion pipeline
**File:** `src/lib/worker/processJob.ts`  
**Problem:** A dedicated claims extraction function (`preExtractEpisodeClaims`) exists in engine.ts with a significantly better prompt than the combined ingestion-time `analyzeChunksBatch`. It was defined but never wired into the ingestion pipeline. The ingestion-time combined prompt (entity + conviction + claims in one call) extracted only 13 claims from 132 Satya chunks (10%), while the dedicated prompt extracts ~24+ from the same episode.  
**Impact:** Most chunks had no claims at all, and those that did had generic subjects from the combined pass.

### Bug 5 (Major): VECTOR_CANDIDATES too small (120)
**File:** `src/lib/matching/engine.ts`  
**Problem:** The $13B Microsoft AI revenue chunk ranked #168 in vector similarity to "Microsoft Corporation". With a cap of 120, it was never retrieved.  
**Impact:** The single most quantified, directly investable MSFT claim in the corpus was invisible.

### Bug 6 (Medium): Entity gate was binary and effectively disabled
**File:** `src/lib/matching/engine.ts`  
**Problem:** `const entityGate = entityRelevance > 0.05 ? 1.0 : 0.35`. Since the baseline entityRelevance for any chunk that passes vector search is 0.15 (semantic match), the gate was always 1.0. Off-topic high-materiality claims (NVIDIA earnings) scored identically to on-topic Microsoft claims.  
**Impact:** Feed ranked by materiality/novelty instead of entity relevance.

---

## 5. Fixes implemented

### Fix 1 — Remove `following` filter from vector search
```typescript
// Before (both queries):
WHERE tc.embedding IS NOT NULL
  AND s."following" = true    // ← REMOVED
  AND e."transcriptStatus" = 'completed'
```
`following=true` now controls the green badge and "Following only" toggle in the UI, not corpus inclusion. Everything you've ingested is your corpus.

### Fix 2 — Ticker expansion in token set + embedding
```typescript
const expandedTokens = [...parsed.tokens];
let expandedEmbedText = parsed.embeddingText;
for (const token of parsed.tokens) {
  const companyName = lookupTicker(token.trim()); // "MSFT" → "Microsoft Corporation"
  if (companyName) {
    const firstName = companyName.split(/\s+/)[0]; // "Microsoft"
    expandedTokens.push(companyName, firstName);
    expandedEmbedText = companyName;
  }
}
```
`getSubsidiaries(["MSFT", "Microsoft Corporation", "Microsoft"])` now correctly finds Azure, GitHub, Copilot, etc. All entity-matching functions use `expandedTokens`.

### Fix 3 — Episode context in claim extraction
```typescript
// preExtractEpisodeClaims now builds:
const episodeContext = `Episode: "${title}" (${sourceName}). Speakers: ${uniqueSpeakers.join(', ')}.`
// Injected into extractAllClaims prompt:
const contextLine = meta?.episodeContext
  ? `\nEpisode context: ${meta.episodeContext}\nWhen speakers use "we", "our", "your company", resolve them to the named company above.\n`
  : '';
```
Result: After re-extraction, all 24 Satya claims have `primarySubject: "Microsoft"`, including the $13B AI revenue claim.

### Fix 4 — Wire `preExtractEpisodeClaims` into ingestion pipeline
```typescript
// processJob.ts, after analyzeChunksBatch completes:
console.log(`[Job ${job.id}] Pass 1.5: Backfilling claims for uncovered chunks...`);
await preExtractEpisodeClaims(episode.id);
```
The dedicated claims prompt (with two-track extraction, verbatim-only enforcement, boundary expansion) now runs for every episode on ingestion. It skips chunks that already have claims from the combined pass, so it only fills gaps.

### Fix 5 — VECTOR_CANDIDATES 120 → 200
Captures the long tail of semantically adjacent but valuable chunks (CEO interviews where the company isn't explicitly named in every chunk).

### Fix 6 — Graduated entity gate
```typescript
// Before: binary, effectively disabled
const entityGate = entityRelevance > 0.05 ? 1.0 : 0.35;

// After: graduated, suppresses off-topic content
const entityGate = entityRelevance >= 0.50 ? 1.0   // primary subject match
                 : entityRelevance >= 0.30 ? 0.60  // mentioned / subsidiary mentioned  
                 : 0.10;                            // semantic match only
```

---

## 6. Before vs after: top 5 MSFT matches

### Before all fixes
| Rank | Score | Source | Claim |
|------|-------|--------|-------|
| #1 | 0.428 | All-In | NVIDIA blew out earnings: $81.6B revenue, +85% YoY |
| #2 | 0.353 | All-In | Starlink: $11.4B revenue, 50% growth, $4.4B op income |
| #3 | 0.342 | All-In | NVIDIA: $5.3T market cap, most valuable company |
| #4 | 0.328 | All-In | Terrestrial data centers: $100-200B revenue by 2030 |
| #5 | 0.325 | All-In | SpaceX raising at $1.75T valuation |

Entity weight: 0.10 for all 61 matches. 0 matches from Satya episode.

### After all fixes
| Rank | Score | Source | Claim |
|------|-------|--------|-------|
| #1 | 0.398 | Satya/Dwarkesh | **Microsoft AI revenue: $13B → $130B in 4 years** |
| #2 | 0.333 | All-In | OpenAI+Anthropic at $100B ARR, 80% gross margins on inference *(relevant: MSFT owns ~49% of OpenAI)* |
| #3 | 0.262 | All-In | OpenAI expected billions from Microsoft deal — hasn't materialized *(partnership health signal)* |
| #4 | 0.248 | All-In | Clover: $1B AI OPEX savings, $200M spent on tokens *(enterprise AI adoption comps for Copilot TAM)* |
| #5 | 0.231 | Satya/Dwarkesh | **Microsoft — SaaS industry worth $100s billion to trillions** |
| #10 | 0.064 | Satya/Dwarkesh | **Microsoft — real benchmark is world GDP growth at 10%** |
| #11 | 0.061 | Satya/Dwarkesh | **Microsoft Azure — Amazon had significant lead, investors said game over — hyperscale not winner-take-all** |
| #14 | 0.038 | Satya/Dwarkesh | **Microsoft — winner-take-all vs not — is "in some sense, everything"** |

Entity weight: 1.00 for direct Microsoft claims, 0.10-0.30 for others.

---

## 7. Remaining frictions (not fixed in this session)

### A. Score gap between direct Microsoft claims and OpenAI claims
The OpenAI and Anthropic ARR claim (#2, score=0.333) still outranks the SaaS valuation claim (#5, score=0.231) because it has more numbers and higher novelty. This is acceptable — Microsoft's OpenAI bet is genuinely relevant — but a tighter `MAX_CLAIMS_PER_SOURCE` for the All-In podcast would prevent it from dominating.

### B. Claims 6-9 in Satya episode still score too low
Several valuable Satya claims (Azure competitive moat, Copilot workflow thesis, quantum milestone) score 0.03-0.06 because their chunks ranked 150-200 in vector similarity and combinedScore is marginal. The `forwardLooking` and `importanceScore` from the combined ingestion pass were 0.0 for many Satya chunks, dragging down `combinedScore`. Re-running the full ingestion on the Satya episode would recalculate these scores with better chunk-level context.

### C. The ingestion-time `analyzeChunksBatch` still writes claims with generic subjects
The combined ingestion prompt doesn't receive episode context — it would need the same `episodeContext` parameter. Currently, the combined pass runs first (without context) and writes claims for ~10% of chunks, and `preExtractEpisodeClaims` skips those chunks (they already have claims). The 10% that get generic subjects from the first pass won't benefit from context.

**Fix:** Pass `episodeContext` to `analyzeChunksBatch` (or delete ingestion-time claims and rely entirely on `preExtractEpisodeClaims` with context).

### D. `openai` is in Microsoft's economic subsidiaries list — too permissive
Any claim about OpenAI gets eco=0.55-0.90 for Microsoft queries. This is somewhat correct (Microsoft invested $13B in OpenAI) but it means OpenAI-primary claims rank above other direct Microsoft claims. Consider a weaker subsidiary weight for investment-only relationships vs product subsidiaries.

### E. No scoring differentiation for speaker authority
When Satya Nadella (Microsoft CEO) makes a claim about "hyperscalers", it should rank higher than when a podcast host speculates about the same. The `relevanceScore` (speakerAuthority) is in the schema and computed but only contributes 5% of `combinedScore`. Speaker authority as a claim-level signal (not just chunk-level) would help surface executive statements.

---

## 8. Code changes summary (Audit 1)

---

# Audit 2 — Topic/Theme Interest Matching
**Date:** 2026-06-02  
**Trigger:** "Quantum" interest returning 100% off-topic content despite a full Satya Nadella episode covering Microsoft's quantum breakthrough

---

## 9. Issues found at start of Audit 2

### State before this audit
- **Quantum feed**: 60 matches, all `ew=0.10`, max score 0.034 — identical to the pre-Audit-1 MSFT baseline failure. Top matches: NVIDIA earnings, Starlink, SpaceX.
- **MSFT feed**: Working correctly from Audit 1 fixes.
- **Claims coverage**: Satya episode 12/132 chunks had claims. Acquired Radio City 34/249. Other All-In episodes 40-50%.

### Root cause cascade for Quantum failure

**Bug 1 (Critical): `computeEntityWeight` highlight match returns 0.2, below entityGate floor**

For a topic interest like "Quantum", claims are extracted with `primarySubject: "Microsoft"` (due to context injection from Audit 1). When searching "Quantum":
- `matchesToken("Microsoft", "Quantum")` → false → skip primary subject
- `mentionedEntities: []` on all quantum claims (LLM didn't populate)
- `matchesToken(claim.highlight, "Quantum")` → TRUE ("quantum" in highlight) → `return 0.2`
- entityGate threshold: `entityRelevance >= 0.30 ? 0.60 : 0.10` → 0.2 < 0.30 → gate = **0.10**
- All quantum-relevant claims got multiplied by 0.10 → near-zero scores

**Bug 2 (Critical): No topic/theme expansion for non-ticker interests**

`parseTerm("Quantum")` → `tokens: ["Quantum"]`. No ticker expansion (not a ticker). No topic expansion logic existed. Claims about "qubit" or "logical qubits" in the highlight would return `entityWeight = 0.10` (baseline) because "qubit" ≠ "Quantum" exactly.

**Bug 3 (High): Claim attribution context over-attributes to company; topic subjects empty**

The Audit 1 fix injected: `"When speakers use 'we'/'our', resolve them to [company]"`. This was correct for MSFT but caused all quantum claims (Satya saying "we built 24 logical qubits") to get `primarySubject: "Microsoft"` and `mentionedEntities: []` — no "quantum computing" entity in any field.

**Bug 4 (Medium): Claim deduplication used max-denominator**

`wordOverlapRatio(a, b) = intersection / max(|a|, |b|)`. A 5-word claim that is a subset of a 20-word claim scored 5/20 = 0.25 — below the 0.70 dedup threshold. Same quote appeared 3× in the MSFT feed.

**Bug 5 (Medium): Tech-milestone materiality missing from `MATERIALITY_PATTERNS`**

Quantum claims ("24 logical qubits", "Majorana zero modes", "transistor moment of quantum computing") scored `materiality ≈ 0.07` because `MATERIALITY_PATTERNS` only contained financial metrics (revenue, margin, CAGR). Without materiality, `eco` for primary-subject-matched claims stayed at 0.65 (below the `materiality > 0.2 → 1.0` threshold).

**Bug 6 (Medium): Short year forms `'27`, `'28`, `'29` not matching**

`FUTURE_YEAR_RE = /\b(202[5-9]|203\d)\b/` — does not match `'27`. Short year forms are used by speech-to-text transcripts for year references. A timeline claim "maybe '27, '28, '29, we will be able to build this" scored zero materiality from the year reference.

**Bug 7 (Medium): `computeFinancialMaterialityScore` checked only highlight, not `numbers` array**

Numbers like `["24 logical qubits", "'27"]` were extracted by the LLM into the `numbers` array but `MATERIALITY_PATTERNS` only checked the `highlight` text. The qubit-count pattern `qubits?` didn't fire because the numbers field wasn't scanned.

---

## 10. Round 1 fixes (all at once)

### Fix 1 — `computeEntityWeight`: raise highlight match 0.2 → 0.5

```typescript
// Before:
if (termTokens.some(t => matchesToken(claim.highlight, t))) return 0.2;
// After:
if (termTokens.some(t => matchesToken(claim.highlight, t))) return 0.5;
```

With `ew=0.5`, `entityRelevance = max(0.5, eco) >= 0.5` → `entityGate = 1.0`. Quantum claims where "quantum" appears in the highlight now pass the gate at full strength.

### Fix 2 — Add `TOPIC_EXPANSIONS` map and expansion logic

```typescript
const TOPIC_EXPANSIONS: Record<string, string[]> = {
  quantum: ['quantum computing', 'quantum computer', 'qubit', 'logical qubit',
            'quantum error correction', 'majorana', 'topological qubit'],
  ai:      ['artificial intelligence', 'language model', 'llm', 'foundation model', ...],
  // ...
};
```

In `matchInterestAgainstEpisodes`: after ticker expansion, check each token against `TOPIC_EXPANSIONS`. If match, add all sub-terms to `expandedTokens` and embed the canonical phrase ("quantum computing") instead of the bare keyword. Result: searching "Quantum" expands to match claims containing "qubit", "logical qubit", "Majorana", etc.

### Fix 3 — Soften context injection for topic attribution

```typescript
// Before:
`When speakers use "we"/"our", resolve them to the named company above.`
// After:
`For claims about a company's business (revenue, customers, products, strategy),
 use that company as primarySubject. For claims about a technology or scientific
 field (e.g. "quantum computing", "AI infrastructure"), use the technology/field
 as primarySubject even when stated by a company representative.`
```

Result: Re-extracted Satya quantum chunks produced 3 claims with `primarySubject: "quantum computing"` — the guidance (timeline), competitive (IBM/Google 100 qubits), and thesis (million qubits on chip) claims.

### Fix 4 — Lower entityGate threshold 0.30 → 0.25

Borderline topic claims with `entityRelevance = 0.25–0.29` now get 0.60 gate instead of 0.10.

### Fix 5 — Claim dedup uses min-denominator

```typescript
// Before:
return intersection / Math.max(aWords.size, bWords.size);
// After:
return intersection / Math.min(aWords.size, bWords.size);
```

A claim that is a subset of another now correctly scores 1.0 overlap (not 0.25). The 3× duplicate "transistor moment" collapsed to 1.

### Fix 6 — Per-primarySubject cap (3 per feed run)

Prevents a single company (e.g. "OpenAI") from appearing more than 3 times in a feed, keeping diversity when one topic dominates the corpus.

### Fix 7 — Ran `preExtractEpisodeClaims` for all 7 episodes

Added 42 new claims across episodes. Crucially: re-processed the 120 zero-claim Satya chunks with the new context injection, extracting 3 quantum-attributed claims.

### Round 1 results

**Quantum feed top 6 after Round 1:**
| Rank | Score | ew | Claim |
|------|-------|----|-------|
| #1 | 0.159 | 1.00 | quantum computing — "maybe '27, '28, '29, we will be able to build this" |
| #2 | 0.128 | 1.00 | quantum computing — "IBM/Google announced 100 physical qubits" |
| #3 | 0.087 | 1.00 | quantum computing — "eventual million qubits will go on a chip" |
| #4 | 0.064 | 0.50 | Microsoft — transistor moment of quantum computing |
| #5 | 0.060 | 0.50 | Microsoft — error correction, 24 logical qubits |
| #6 | 0.042 | 0.50 | Microsoft — Majorana zero modes, new phase of matter |

Before: 0/60 matches were relevant. After: 6/12 (top half) are quantum-specific.

---

## 11. Round 2 fixes (after reanalysis)

### Remaining issues after Round 1

1. Quantum #1 score capped at 0.159: regex `\b` fails before `'` (apostrophe), so short-year patterns didn't fire. `materiality=0.07` instead of expected `~0.29`, keeping `eco=0.65` instead of `1.0`.
2. Dedup incomplete: `wordOverlapRatio` fixed (min denominator), but needed to verify.
3. Tech-milestone patterns missing: Majorana, existence proof, etc. not in `MATERIALITY_PATTERNS`.
4. `computeFinancialMaterialityScore` checked `highlight` only — numbers array values ignored.

### Fix 1 — Add tech-milestone materiality patterns

```typescript
{ re: /\b(qubits?|logical\s+qubits?|physical\s+qubits?|error\s+correction|coherence)\b/i, pts: 0.18 },
{ re: /\b(majorana|topological\s+qubit|phase\s+of\s+matter)\b/i,                          pts: 0.16 },
{ re: /\b(transistor\s+moment|existence\s+proof|physics\s+breakthrough)\b/i,              pts: 0.14 },
{ re: /\b(utility.?scale|fault.?tolerant|error.?rate|fidelity)\b/i,                       pts: 0.14 },
{ re: /(?:by|in|maybe|around)\s+'2[5-9]|'2[5-9]\s*,\s*'[23]\d/i,                         pts: 0.10 },
```

### Fix 2 — `computeFinancialMaterialityScore` scans `numbers` array

```typescript
// Before: for (const { re, pts } of MATERIALITY_PATTERNS) { if (re.test(highlight)) ...
// After:
const combined = numbers.join(' ') + ' ' + highlight;
for (const { re, pts } of MATERIALITY_PATTERNS) { if (re.test(combined)) ...
```

Numbers like `["'27", "'28", "'29"]` and `["24 logical qubits"]` now contribute to materiality.

### Fix 3 — Updated `FUTURE_YEAR_RE` to match short forms

```typescript
// Before: /\b(202[5-9]|203\d)\b/
// After:  /\b(202[5-9]|203\d)\b|'2[5-9]\b|'3[0-9]\b/
```

### Round 2 results

**Quantum #1 score: 0.159 → 0.205** (regex + combined-string fix unblocked materiality → eco path improved).

**Final Quantum feed:**
| Rank | Score | ew | Claim |
|------|-------|----|-------|
| #1 | 0.205 | 1.00 | quantum computing — timeline: "'27, '28, '29, we will be able to build this" |
| #2 | 0.128 | 1.00 | quantum computing — "IBM/Google announced 100 physical qubits" |
| #3 | 0.087 | 1.00 | quantum computing — "eventual million qubits will go on a chip" |
| #4 | 0.064 | 0.50 | Microsoft — transistor moment of quantum computing |
| #5 | 0.060 | 0.50 | Microsoft — error correction, 24 logical qubits |
| #6 | 0.042 | 0.50 | Microsoft — Majorana zero modes, new phase of matter |
| #7+ | ≤0.036 | 0.10 | All-In noise (NVIDIA, Starlink) — below all quantum-specific claims |

**MSFT feed:** Unchanged — $13B AI revenue still #1. No regressions.

---

## 12. Remaining frictions after Audit 2

### A. Quantum #1 claim is missing context ("build this")
`"maybe '27, '28, '29, we will be able to actually build this"` — the referent ("a utility-scale quantum computer") is in the previous chunk. Boundary expansion ran but the claim was extracted too narrowly. The boundary expansion prompt (`expandHighlight`) requires the same speakerLabel — if chunks swap speakers, the context is unavailable.

### B. Score gap between topic and financial interests
Quantum max = 0.205, MSFT max = 0.398. Topic interests will always score lower because `MATERIALITY_PATTERNS` is dominated by financial metrics (revenue, margins, CAGR). An investor following "Quantum" needs a different value signal (milestone progress, competitive rank, timeline risk) than an investor following "MSFT". The investmentScore formula isn't topic-aware.

**Possible fix**: Detect interest type (company ticker vs topic) at matching time and reweight: for topics, reduce `materiality` weight from 22% → 10% and increase `numericInfo` (has specific technical numbers) + `novelty` weights.

### C. All-In content noise floor (0.031–0.036) in Quantum feed
7 of the top 12 matches in the Quantum feed are semantically adjacent but topically irrelevant (NVIDIA compute, software developer hiring). They appear because vector similarity to "quantum computing" is non-zero for compute-adjacent content, and their materiality is high. They score below all quantum-specific claims but occupy lower slots in the feed. A minimum entity-relevance threshold (e.g. cut matches with `entityRelevance < 0.20` entirely) would clean this up.

### D. Ingestion-time `analyzeChunksBatch` still lacks context
The combined ingestion pass (Pass 1) still runs without episode context. Chunks that receive claims from this pass (rather than `preExtractEpisodeClaims`) still get generic subjects. Only Pass 1.5 benefits from context injection.

### E. Claims coverage still low for long episodes
Acquired Radio City (249 chunks): 39/249 = 16% coverage. Much of this is genuinely filler (show intro, audience cheers), but the JP Morgan/New York Times interview sections likely have unclaimed substantive chunks. Needs investigation.

---

## 13. Code changes summary (Audit 2)

| File | Change |
|------|--------|
| `src/lib/matching/engine.ts` | Add `TOPIC_EXPANSIONS` map |
| `src/lib/matching/engine.ts` | `computeEntityWeight` highlight match: 0.2 → 0.5 |
| `src/lib/matching/engine.ts` | `computeEntityWeight` mention match: 0.3 → 0.55 (non-transaction) |
| `src/lib/matching/engine.ts` | entityGate lower threshold: 0.30 → 0.25 |
| `src/lib/matching/engine.ts` | Updated context injection to allow topic-specific primarySubject |
| `src/lib/matching/engine.ts` | Topic expansion logic in `matchInterestAgainstEpisodes` |
| `src/lib/matching/engine.ts` | `wordOverlapRatio`: max-denominator → min-denominator |
| `src/lib/matching/engine.ts` | Per-primarySubject cap (`MAX_CLAIMS_PER_SUBJECT = 3`) |
| `src/lib/matching/engine.ts` | Tech-milestone `MATERIALITY_PATTERNS` (qubits, Majorana, transistor moment, short years) |
| `src/lib/matching/engine.ts` | `FUTURE_YEAR_RE`: add `'2[5-9]\b` short form |
| `src/lib/matching/engine.ts` | `computeFinancialMaterialityScore`: scan `combined` (numbers + highlight) |
| `src/lib/matching/engine.ts` | `wordOverlapRatio` helper + `claimHighlights` map for dedup |

## 8. Code changes summary

| File | Change |
|------|--------|
| `src/lib/matching/engine.ts` | Remove `following=true` from both vectorSearch queries |
| `src/lib/matching/engine.ts` | Import `lookupTicker`, expand ticker tokens + embedding in `matchInterestAgainstEpisodes` |
| `src/lib/matching/engine.ts` | Add `episodeContext` field to `ChunkMeta` interface |
| `src/lib/matching/engine.ts` | Inject context line into `extractAllClaims` prompt |
| `src/lib/matching/engine.ts` | Fetch episode title + speaker names in `preExtractEpisodeClaims`, build context string |
| `src/lib/matching/engine.ts` | Change `VECTOR_CANDIDATES` from 120 → 200 |
| `src/lib/matching/engine.ts` | Graduated entity gate: `>= 0.50 → 1.0`, `>= 0.30 → 0.60`, `< 0.30 → 0.10` |
| `src/lib/worker/processJob.ts` | Import `preExtractEpisodeClaims`, call it after ingestion-time analysis (Pass 1.5) |
