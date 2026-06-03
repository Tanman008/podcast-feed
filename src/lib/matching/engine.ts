// Interest matching engine
// Architecture: Claims are the unit of output. One chunk → 0-7 Claims.
//   1. Embed the query
//   2. Vector search → top chunks
//   3. Load pre-extracted Claims for those chunks (no LLM at match time)
//   4. Score: chunkCombinedScore × claimTypeWeight × entityRelationshipWeight
//   5. Cap per episode, rank, persist to InterestMatch

import OpenAI from 'openai';
import pLimit from 'p-limit';
import { db } from '@/lib/db';
import { parseTerm } from './parser';
import { lookupTicker } from '@/lib/tickers/lookup';
import { withRetry } from '@/lib/utils/retry';
import { TOPIC_EXPANSIONS } from './topicExpansions';
import type { ExtractedClaim } from '@/lib/ingestion/entityExtractor';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? 'missing' });

const VECTOR_CANDIDATES = 200;
const MAX_CLAIMS_PER_EPISODE = 20;
const MAX_CLAIMS_PER_SOURCE = 25;
const SCORE_THRESHOLD = 0.15;
const CLAIM_CONCURRENCY = 8;

// Pre-filter: only skip chunks that are clearly non-investable (CHITCHAT/sponsor reads).
// Intentionally broad — let the LLM decide on qualitative claims.
const SIGNAL_RE = /\$[\d,]+|\d+%|billion|million|revenue|margin|growth|buying|selling|\blong\b|\bshort\b|guidance|forecast|expect|price.?target|valuation|raise|fund|invest|deal|partner|customer|enterprise|product|model|compet|strateg|market|position/i;

// Topic/theme expansions for non-company interests.
// A "Quantum" interest will match claims containing any of these tokens,
// with the same entity-weight logic as a direct mention.

// Economic subsidiaries/products per parent company (normalized lowercase).
// A claim whose primarySubject is one of these is treated as high-exposure
// to the parent — e.g. "GitHub Copilot revenue" ranks highly for "Microsoft".
const ECONOMIC_SUBSIDIARIES: Record<string, string[]> = {
  microsoft:  ['azure', 'github', 'copilot', 'office', '365', 'linkedin', 'windows', 'teams', 'dynamics', 'bing', 'xbox', 'activision', 'nuance', 'openai'],
  google:     ['youtube', 'deepmind', 'waymo', 'google cloud', 'gemini', 'android', 'chrome', 'alphabet'],
  amazon:     ['aws', 'prime', 'alexa', 'twitch', 'ring', 'whole foods', 'audible', 'mgm'],
  apple:      ['app store', 'icloud', 'siri', 'apple pay', 'iphone', 'mac', 'ipad', 'vision pro', 'apple intelligence'],
  meta:       ['instagram', 'whatsapp', 'reality labs', 'llama', 'threads', 'facebook', 'oculus', 'ray-ban'],
  nvidia:     ['cuda', 'h100', 'h200', 'b200', 'hopper', 'blackwell', 'nemo', 'nim', 'dgx', 'nvlink'],
  openai:     ['chatgpt', 'gpt', 'dall-e', 'sora', 'o1', 'o3', 'codex'],
  anthropic:  ['claude', 'sonnet', 'haiku', 'opus'],
  tesla:      ['full self-driving', 'fsd', 'dojo', 'megapack', 'powerwall', 'supercharger', 'optimus'],
  salesforce: ['slack', 'tableau', 'mulesoft', 'einstein', 'agentforce'],
};

// Higher multiplier = more investment signal value.
// Guidance and growth outrank positional/thesis statements.
const CLAIM_TYPE_MULTIPLIERS: Record<string, number> = {
  guidance:       2.0,
  growth:         1.8,
  unit_economics: 1.8,
  transaction:    1.6,
  valuation:      1.5,
  competitive:    1.3,
  position:       1.0,
  thesis:         0.8,
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface CandidateChunk {
  id: string;
  episodeId: string;
  sourceId: string;
  importanceScore: number | null;
  forwardLookingScore: number | null;
  authorityScore: number | null;
  noveltyScore: number | null;
  publishedAt: Date | null;
  episodeCreatedAt: Date;
  vectorScore: number;
  combinedScore: number;
}


interface ChunkMeta {
  episodeId: string;
  chunkIndex: number;
  speakerLabel: string | null;
  episodeContext?: string;
  sourceLanguage?: string;  // e.g. "German" — triggers translation instruction in prompt
}

// ─── Embed ────────────────────────────────────────────────────────────────────

async function embedQuery(text: string): Promise<number[]> {
  const res = await withRetry(() =>
    openai.embeddings.create({ model: 'text-embedding-3-small', input: text, dimensions: 1536 })
  );
  return res.data[0].embedding;
}

// ─── Vector search ────────────────────────────────────────────────────────────

type VectorRow = {
  id: string; episodeId: string; sourceId: string; similarity: number;
  importanceScore: number | null; forwardLookingScore: number | null;
  authorityScore: number | null; noveltyScore: number | null;
  publishedAt: Date | null; episodeCreatedAt: Date;
};

async function vectorSearch(
  embedding: number[],
  episodeIds: string[] | null,
  limit: number
): Promise<VectorRow[]> {
  const vectorStr = JSON.stringify(embedding);
  if (episodeIds !== null && episodeIds.length === 0) return [];

  // Search all completed episodes — following=true controls the green badge
  // and feed filter, not corpus inclusion. Everything ingested is searchable.
  return episodeIds
    ? db.$queryRaw<VectorRow[]>`
        SELECT tc.id, tc."episodeId",
               tc."importanceScore",
               tc."convictionScore" AS "forwardLookingScore",
               tc."relevanceScore"  AS "authorityScore",
               tc."noveltyScore",
               e."publishedAt", e."createdAt" AS "episodeCreatedAt",
               e."sourceId",
               1 - (tc.embedding <=> ${vectorStr}::vector) AS similarity
        FROM "TranscriptChunk" tc
        JOIN "Episode" e ON e.id = tc."episodeId"
        WHERE tc.embedding IS NOT NULL
          AND e."transcriptStatus" = 'completed'
          AND tc."episodeId" = ANY(${episodeIds}::text[])
        ORDER BY tc.embedding <=> ${vectorStr}::vector
        LIMIT ${limit}
      `
    : db.$queryRaw<VectorRow[]>`
        SELECT tc.id, tc."episodeId",
               tc."importanceScore",
               tc."convictionScore" AS "forwardLookingScore",
               tc."relevanceScore"  AS "authorityScore",
               tc."noveltyScore",
               e."publishedAt", e."createdAt" AS "episodeCreatedAt",
               e."sourceId",
               1 - (tc.embedding <=> ${vectorStr}::vector) AS similarity
        FROM "TranscriptChunk" tc
        JOIN "Episode" e ON e.id = tc."episodeId"
        WHERE tc.embedding IS NOT NULL
          AND e."transcriptStatus" = 'completed'
        ORDER BY tc.embedding <=> ${vectorStr}::vector
        LIMIT ${limit}
      `;
}

// ─── Claim extraction ─────────────────────────────────────────────────────────
// Single LLM call per chunk: classify + extract all claims + generate gloss.
// Saves results to the Claim table. Caller must ensure chunks without existing
// claims are passed (preExtractEpisodeClaims handles deduplication).

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function expandHighlight(
  highlight: string,
  prevSentences: string,
  nextSentences: string
): Promise<string> {
  const prompt = `Given this expanded context, does the claim below start or end mid-thought? If so, extend the verbatim highlight to include the natural start or end of the complete thought. Do not add more than 2 sentences in either direction.

Current highlight:
${highlight}
${prevSentences ? `\nPreceding context:\n${prevSentences}` : ''}
${nextSentences ? `\nFollowing context:\n${nextSentences}` : ''}

Return the complete verbatim highlight only. If the current highlight is already complete, return it unchanged.`;

  try {
    const res = await withRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.1,
      })
    );
    return res.choices[0]?.message?.content?.trim() || highlight;
  } catch {
    return highlight;
  }
}

async function extractAllClaims(
  chunkId: string,
  chunkText: string,
  meta?: ChunkMeta
): Promise<ExtractedClaim[]> {
  if (chunkText.trim().length < 40) return [];

  const contextLine = meta?.episodeContext
    ? `\nEpisode context: ${meta.episodeContext}\nAttribution guidance: Use speaker context to resolve first-person pronouns. For claims about a company's business (revenue, customers, products, strategy), use that company as primarySubject. For claims about a technology, scientific field, or industry dynamic (e.g. "quantum computing", "AI infrastructure", "cloud market structure"), use the technology or field as primarySubject — even when stated by a company representative.\n`
    : '';

  const langLine = meta?.sourceLanguage && meta.sourceLanguage.toLowerCase() !== 'english'
    ? `\nLANGUAGE: This transcript is in ${meta.sourceLanguage}. Write ALL output fields in English. Translate highlights to natural, accurate English — the VERBATIM rule does not apply. Preserve numbers and proper nouns exactly.\n`
    : '';

  const prompt = `You are extracting investor-relevant claims from a financial podcast transcript.
${contextLine}${langLine}
There are TWO distinct tracks. Extract both:

── SIGNAL CLAIMS (claimType: unit_economics | transaction | growth | guidance | valuation) ──
Factual, evidence-backed assertions. Prefer 2-3 verbatim sentences.
- "AI coding agents have grown from a $500M run rate to $56B — a 10x move in one year. GitHub Copilot now competes with Cursor, Cognition, and OpenAI Codecs across the same TAM." ✓ growth
- "Enterprise gross margins on inference went from well below 50% to above 70% this year alone." ✓ unit_economics
specificity = how precise and measurable the data is (0.7+ if quantified)
completeness = 0.5-0.7 for 1 sentence with full data; 0.7-1.0 for 2-3 sentences

── IDEAS CLAIMS (claimType: thesis | competitive | position) ──
Directional beliefs and structural insights. Include as many verbatim sentences as needed to capture the complete idea — typically 1-3.
- "Structurally, hyperscale will never be a winner take all, because buyers are smart." ✓ thesis — falsifiable, specific, complete in 1 sentence
- "The model layer will be commoditized once inference becomes cheap enough. Every incumbent who built a moat on proprietary models is going to face a margin collapse in the next 18 months." ✓ thesis — 2 sentences, stronger
- "Microsoft's scaffolding advantage disappears if models become reliable end-to-end. The only reason Copilot has pricing power today is that raw models still fail on complex multi-step tasks." ✓ competitive
specificity = how clearly-defined and arguable the idea is — NOT whether it has numbers
  High specificity (0.7): makes a falsifiable claim about a specific market dynamic
  Low specificity (0.2): vague generalization like "AI will change everything"
completeness = 0.5 for 1 self-contained sentence; 0.6-0.7 for 2 sentences; 0.8+ with full reasoning chain

VERBATIM ONLY: Every word in the highlight MUST appear verbatim in the chunk text. Never write a new sentence. Never paraphrase. Never add "This indicates that..." or any synthesis. Copy and paste only.

SELF-CONTAINED: If the highlight uses a pronoun ("this", "it", "that", "they", "these") whose referent is not explicit within the highlight itself, extend the highlight backward to include the sentence(s) that name the referent. The highlight must be interpretable in isolation — a reader with no context should know what is being claimed.

ASR CLEANUP: Speech-to-text produces artifacts — fix these in the highlight only:
- Spelled-out numbers in financial/numeric contexts: "forty five billion" → "$45B", "twenty percent" → "20%", "two hundred million dollars" → "$200M"
- Multipliers: "four x" / "four times" → "4x", "three x" → "3x", "ten x" → "10x"
- Fiscal quarters: "four q" / "q four" / "fourth quarter" → "Q4", "one q" → "Q1", "two q" → "Q2", "three q" → "Q3"
- Do not change any word that isn't a clear ASR artifact.

For each claim:
{
  "highlight": "verbatim text with ASR artifacts fixed",
  "context": "SPEAKER NAME IN CAPS (on brief topic, 5-8 words). Use the surrounding chunk to identify what's being discussed at this moment. Do NOT name the primarySubject entity — describe the broader conversational topic. Example: 'JENSEN (on the economics of inference scaling)'. If speaker unknown write 'SPEAKER'.",
  "startSentenceIndex": 0,
  "endSentenceIndex": 0,
  "primarySubject": "entity this claim is ABOUT",
  "mentionedEntities": ["other entities referenced"],
  "claimType": "unit_economics|transaction|growth|thesis|position|competitive|valuation|guidance",
  "specificity": 0.0-1.0,
  "completeness": 0.4-1.0,
  "gloss": null,
  "numbers": ["every specific quantified fact verbatim: dollar amounts, percentages, multiples, counts, dates — empty array if none"]
}

Return claims:[] ONLY for: pure filler, host introductions, ad reads, or chunks with zero substantive content.

Return ONLY valid JSON:
{"chunkType":"ARGUMENT|POSITION|DATA|THESIS|OPINION|CHITCHAT","claims":[...]}

Chunk:
"""
${chunkText}
"""`;

  try {
    const response = await withRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2500,
        temperature: 0.1,
      })
    );

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return [];

    const parsed = JSON.parse(raw) as { chunkType: string; claims: ExtractedClaim[] };
    const valid = (parsed.claims ?? []).filter(
      c => c.completeness >= 0.5 && typeof c.highlight === 'string' && typeof c.claimType === 'string'
    );
    console.log(`[extractAllClaims] chunk ${chunkId}: type=${parsed.chunkType}, raw=${parsed.claims?.length ?? 0} claims, valid=${valid.length}`);

    // Boundary expansion: check if any claim starts/ends near a chunk boundary
    if (meta) {
      const totalWords = countWords(chunkText);
      const textLower = chunkText.toLowerCase();

      for (const c of valid) {
        const hlWords = c.highlight.split(/\s+/).filter(Boolean);
        const hlFirst = hlWords.slice(0, 5).join(' ').toLowerCase();
        const hlLast  = hlWords.slice(-5).join(' ').toLowerCase();

        const startChar = hlFirst ? textLower.indexOf(hlFirst) : -1;
        const endChar   = hlLast  ? textLower.lastIndexOf(hlLast) + hlLast.length : -1;

        const wordsBefore  = startChar > 0 ? countWords(chunkText.slice(0, startChar)) : 0;
        const wordsThrough = endChar   > 0 ? countWords(chunkText.slice(0, endChar))   : totalWords;

        const nearStart = wordsBefore  <= 30;
        const nearEnd   = wordsThrough >= totalWords - 30;
        if (!nearStart && !nearEnd) continue;

        let prevSentences = '';
        let nextSentences = '';

        if (nearStart && meta.chunkIndex > 0) {
          const prev = await db.transcriptChunk.findFirst({
            where: {
              episodeId: meta.episodeId,
              chunkIndex: meta.chunkIndex - 1,
              speakerLabel: meta.speakerLabel,
            },
            select: { text: true },
          });
          if (prev) {
            const sents = prev.text.match(/[^.!?]+[.!?]*/g)?.map(s => s.trim()).filter(Boolean) ?? [];
            prevSentences = sents.slice(-2).join(' ');
          }
        }

        if (nearEnd) {
          const next = await db.transcriptChunk.findFirst({
            where: {
              episodeId: meta.episodeId,
              chunkIndex: meta.chunkIndex + 1,
              speakerLabel: meta.speakerLabel,
            },
            select: { text: true },
          });
          if (next) {
            const sents = next.text.match(/[^.!?]+[.!?]*/g)?.map(s => s.trim()).filter(Boolean) ?? [];
            nextSentences = sents.slice(0, 2).join(' ');
          }
        }

        if (prevSentences || nextSentences) {
          c.highlight = await expandHighlight(c.highlight, prevSentences, nextSentences);
        }
      }
    }

    for (const c of valid) {
      await db.claim.create({
        data: {
          chunkId,
          highlight: c.highlight,
          context:   (!c.context || c.context.toLowerCase() === 'null') ? null : c.context,
          startSentenceIndex: c.startSentenceIndex ?? 0,
          endSentenceIndex: c.endSentenceIndex ?? 0,
          primarySubject: c.primarySubject ?? null,
          mentionedEntities: c.mentionedEntities ?? [],
          claimType: c.claimType,
          specificity: c.specificity ?? 0.5,
          completeness: c.completeness,
          gloss: (!c.gloss || c.gloss.toLowerCase() === 'null') ? null : c.gloss,
          numbers: Array.isArray(c.numbers) ? c.numbers.filter(n => typeof n === 'string') : [],
        },
      });
    }

    return valid;
  } catch (err) {
    console.error(`[extractAllClaims] chunk ${chunkId}:`, err);
    return [];
  }
}

// ─── Entity relationship weight ───────────────────────────────────────────────
// primarySubject match: 1.0 — claim is about the searched entity
// transaction counterparty: 0.8 — entity is the other side of a named deal
// mention only: 0.3 — entity is referenced but not the subject

function matchesToken(text: string, token: string): boolean {
  try {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  } catch {
    return false;
  }
}

function computeEntityWeight(
  claim: { primarySubject: string | null; mentionedEntities: string[]; claimType: string; highlight: string },
  termTokens: string[]
): number {
  if (claim.primarySubject && termTokens.some(t => matchesToken(claim.primarySubject!, t))) return 1.0;
  const mentioned = claim.mentionedEntities.some(e => termTokens.some(t => matchesToken(e, t)));
  // Transaction mention: entity is likely party to the deal, keep strong (0.80, clears 0.50 gate).
  // Non-transaction mention: entity appears in context but isn't the subject — lowered from 0.55
  // to 0.35 so it falls in the 0.25-0.50 gate tier (multiplied by 0.60 instead of 1.0).
  // Prevents "Elon Musk mentioned once at chunk start" from ranking alongside claims actually about him.
  if (mentioned) return claim.claimType === 'transaction' ? 0.80 : 0.35;
  if (termTokens.some(t => matchesToken(claim.highlight, t))) return 0.5;
  return 0.1;
}

// ─── Investment signal scoring ────────────────────────────────────────────────

const MATERIALITY_PATTERNS: { re: RegExp; pts: number }[] = [
  { re: /\b(revenue|ARR|MRR|bookings?|run rate|recurring)\b/i,                        pts: 0.18 },
  { re: /\b(margin|gross margin|operating margin|EBITDA|profitab)\b/i,                 pts: 0.18 },
  { re: /\b(growth rate|CAGR|YoY|QoQ|grew|growing|grown)\b/i,                         pts: 0.14 },
  { re: /\b(TAM|market size|market share|addressable|penetration)\b/i,                 pts: 0.14 },
  { re: /\b(CapEx|capital expenditure|acquisition|buyback)\b/i,                        pts: 0.12 },
  { re: /\b(valuation|multiple|P\/E|EV|price.?target|worth)\b/i,                       pts: 0.14 },
  { re: /\b(unit economics?|inference cost|token cost|cost per|pricing)\b/i,           pts: 0.14 },
  { re: /\b(projected?|forecast|guidance|expected?|by 20\d\d|next year|long.?term|outlook)\b/i, pts: 0.10 },
  { re: /\b(trillion|billion|million)\s*(dollar|of\s+dollar|\$)?s?\b/i,                pts: 0.16 },
  { re: /\b(hundred|thousand)s?\s+of\s+(billion|trillion|million)s?\b/i,               pts: 0.20 },
  { re: /\b(commoditize|commoditized|margin\s+compress|margin\s+collapse|pricing\s+power)\b/i, pts: 0.14 },
  { re: /\b(winner.?take.?all|network\s+effect|moat|lock.?in|switching\s+cost)\b/i,   pts: 0.12 },
  // Technology milestone patterns — for quantum/AI/biotech interests where signal
  // is measured in qubits, error rates, model capabilities, or named breakthroughs.
  { re: /\b(qubits?|logical\s+qubits?|physical\s+qubits?|error\s+correction|coherence)\b/i, pts: 0.18 },
  { re: /\b(majorana|topological\s+qubit|topological|phase\s+of\s+matter)\b/i,        pts: 0.16 },
  { re: /\b(transistor\s+moment|existence\s+proof|physics\s+breakthrough|fabrication\s+breakthrough)\b/i, pts: 0.14 },
  { re: /\b(utility.?scale|fault.?tolerant|error.?rate|fidelity|gate\s+fidelity)\b/i, pts: 0.14 },
  { re: /(?:by|in|maybe|perhaps|around)\s+'2[5-9]|(?:\s|,)'2[5-9]\s*,\s*'[23]\d/i,    pts: 0.10 }, // short year forms: '27, '28, '29 (no \b — apostrophe is non-word char)
  { re: /\b(clinical\s+trial|fda\s+approval|efficacy|drug\s+candidate|phase\s+[23])\b/i, pts: 0.18 },
  { re: /\b(parameter|token|context\s+window|inference|fine.?tun)\b/i,                pts: 0.08 },
];

const LARGE_DOLLAR_RE = /\$\s*[\d,.]+\s*[TB]/i;
const MID_DOLLAR_RE   = /\$\s*[\d,.]+\s*[MB]/i;
const PCT_METRIC_RE   = /\d+\.?\d*\s*%/;
const FUTURE_YEAR_RE  = /\b(202[5-9]|203\d)\b|'2[5-9]\b|'3[0-9]\b/;

function computeFinancialMaterialityScore(highlight: string, numbers: string[]): number {
  // Check patterns against combined string so numbers like "24 logical qubits" or
  // "'27" in the numbers array contribute even when not repeated verbatim in highlight.
  const combined = numbers.join(' ') + ' ' + highlight;
  let score = 0;
  let categoryHits = 0;
  for (const { re, pts } of MATERIALITY_PATTERNS) {
    if (re.test(combined)) { score += pts; categoryHits++; }
  }
  if (LARGE_DOLLAR_RE.test(combined)) score += 0.30;
  else if (MID_DOLLAR_RE.test(combined)) score += 0.18;
  if (PCT_METRIC_RE.test(combined)) score += 0.10;
  if (FUTURE_YEAR_RE.test(combined)) score += 0.07;
  if (categoryHits > 0 && numbers.length > 0) score += 0.12; // keyword + number synergy
  return Math.min(1.0, score);
}

function computeNumericInformationScore(numbers: string[], highlight: string): number {
  if (numbers.length === 0 && !PCT_METRIC_RE.test(highlight)) return 0.05;
  let score = Math.min(0.40, numbers.length * 0.13);
  const combined = numbers.join(' ') + ' ' + highlight;
  if (LARGE_DOLLAR_RE.test(combined)) score += 0.40;
  else if (MID_DOLLAR_RE.test(combined)) score += 0.22;
  if (PCT_METRIC_RE.test(combined)) score += 0.18;
  if (FUTURE_YEAR_RE.test(combined)) score += 0.10;
  return Math.min(1.0, score);
}

function computeForwardLookingTextScore(highlight: string, chunkScore: number | null): number {
  const base = chunkScore ?? 0.5;
  const bonus = MATERIALITY_PATTERNS[7].re.test(highlight) ? 0.25 : 0;
  return Math.min(1.0, base + bonus);
}

// ─── Economic exposure scoring ────────────────────────────────────────────────
// Answers: "Is this claim economically relevant to the searched entity?"
// Direct subject match > economic subsidiary match > entity mention > baseline.
// Materiality amplifies exposure: a claim about Azure revenue scores higher
// than a claim that merely names Azure.

function getSubsidiaries(termTokens: string[]): string[] {
  for (const [parent, subs] of Object.entries(ECONOMIC_SUBSIDIARIES)) {
    if (termTokens.some(t => t.toLowerCase() === parent || parent.includes(t.toLowerCase()))) {
      return subs;
    }
  }
  return [];
}

function isSubsidiaryMatch(entity: string, subsidiaries: string[]): boolean {
  const lower = entity.toLowerCase();
  return subsidiaries.some(sub => lower.includes(sub) || sub.includes(lower));
}

function computeEconomicExposureScore(
  claim: { primarySubject: string | null; mentionedEntities: string[]; highlight: string },
  termTokens: string[],
  materiality: number
): number {
  const subsidiaries = getSubsidiaries(termTokens);
  const allEntities = [
    ...(claim.primarySubject ? [claim.primarySubject] : []),
    ...claim.mentionedEntities,
  ];

  // Primary subject IS the searched entity
  if (claim.primarySubject && termTokens.some(t => matchesToken(claim.primarySubject!, t))) {
    return materiality > 0.2 ? 1.0 : 0.65;
  }

  // Primary subject is a known economic subsidiary (e.g. "GitHub Copilot" for "Microsoft")
  if (subsidiaries.length > 0 && claim.primarySubject && isSubsidiaryMatch(claim.primarySubject, subsidiaries)) {
    return materiality > 0.3 ? 0.90 : 0.55;
  }

  // Searched entity appears as a mentioned entity (not primary subject)
  if (allEntities.some(e => termTokens.some(t => matchesToken(e, t)))) {
    return materiality > 0.2 ? 0.50 : 0.35;
  }

  // A subsidiary appears as a mentioned entity
  if (subsidiaries.length > 0 && allEntities.some(e => isSubsidiaryMatch(e, subsidiaries))) {
    return materiality > 0.3 ? 0.45 : 0.25;
  }

  // Only in highlight text
  if (termTokens.some(t => matchesToken(claim.highlight, t))) return 0.25;

  // Chunk passed vector search but entity not named — semantic match only
  return 0.15;
}

// ─── Platitude penalty ────────────────────────────────────────────────────────
// Detects corporate boilerplate that sounds meaningful but contains no
// investable information. Reduces score; does not hard-drop.

const PLATITUDE_PATTERNS = [
  /\b(uniquely|especially|particularly|perfectly|ideally)\s+(fit|positioned|suited|privileged|placed)\b/i,
  /\bis\s+(well|perfectly|ideally)\s+positioned\b/i,
  /\bhas\s+(strong|deep|unique|excellent|incredible)\s+(relationship|partnership|presence|advantage)\b/i,
  /\b(excited|incredibly\s+excited|thrilled|delighted)\s+(about|for|by)\b/i,
  /\b(deeply\s+)?committed\s+to\b/i,
  /\b(incredible|amazing|massive|huge|big)\s+(opportunity|potential|moment|tailwind)\b/i,
  /\bcore\s+to\s+(our|the|their)\s+strategy\b/i,
  /\bwell.?placed\s+to\b/i,
  /\b(very|extremely)\s+(bullish|positive|optimistic)\b/i,
];

function computePlatitudePenalty(highlight: string): number {
  let hits = 0;
  for (const re of PLATITUDE_PATTERNS) {
    if (re.test(highlight)) hits++;
  }
  return Math.min(0.60, hits * 0.20);
}

// ─── Claim deduplication ─────────────────────────────────────────────────────
// When an episode has multiple overlapping chunks covering the same quote
// (e.g. boundary expansion produces 3 versions of the same sentence), we only
// want the highest-scoring version in the feed.

function wordOverlapRatio(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let intersection = 0;
  for (const w of aWords) { if (bWords.has(w)) intersection++; }
  // Use min-denominator so that subset claims are caught: a 5-word claim
  // that is entirely contained in a 20-word claim scores 1.0, not 0.25.
  return intersection / Math.min(aWords.size, bWords.size);
}

// ─── Core matching ────────────────────────────────────────────────────────────

export async function matchInterestAgainstEpisodes(
  interestId: string,
  term: string,
  episodeIds: string[] | null
): Promise<number> {
  const parsed = parseTerm(term);

  // Expand tickers to company names: "MSFT" → tokens include "Microsoft"
  // so getSubsidiaries finds azure/copilot/etc, and entity matching works against
  // claims that name "Microsoft" rather than the ticker symbol.
  const expandedTokens = [...parsed.tokens];
  let expandedEmbedText = parsed.embeddingText;
  for (const token of parsed.tokens) {
    const companyName = lookupTicker(token.trim());
    if (companyName) {
      const firstName = companyName.split(/\s+/)[0];
      if (!expandedTokens.includes(companyName)) expandedTokens.push(companyName);
      if (!expandedTokens.includes(firstName)) expandedTokens.push(firstName);
      expandedEmbedText = companyName;
    }
  }

  // Expand topic/theme terms: "Quantum" → ["quantum computing", "qubit", "majorana", ...]
  // so entity matching fires on claims that discuss the topic even without naming it explicitly.
  for (const token of parsed.tokens) {
    const lower = token.toLowerCase();
    for (const [key, subs] of Object.entries(TOPIC_EXPANSIONS)) {
      if (lower === key || lower.startsWith(key + ' ')) {
        for (const sub of subs) {
          if (!expandedTokens.includes(sub)) expandedTokens.push(sub);
        }
        // Use first expansion as embedding text (more canonical than bare keyword)
        expandedEmbedText = subs[0];
        break;
      }
    }
  }

  const embedding = await embedQuery(expandedEmbedText);

  const vectorResults = await vectorSearch(embedding, episodeIds, VECTOR_CANDIDATES);
  console.log(`[match "${term}"] vector: ${vectorResults.length} chunks`);
  if (vectorResults.length === 0) return 0;

  const candidates: CandidateChunk[] = vectorResults.map(r => ({
    id: r.id,
    episodeId: r.episodeId,
    sourceId: r.sourceId,
    importanceScore: r.importanceScore,
    forwardLookingScore: r.forwardLookingScore,
    authorityScore: r.authorityScore,
    noveltyScore: r.noveltyScore,
    publishedAt: r.publishedAt,
    episodeCreatedAt: r.episodeCreatedAt,
    vectorScore: r.similarity,
    combinedScore:
      0.60 * r.similarity +
      0.20 * (r.importanceScore ?? 0.5) +
      0.15 * (r.forwardLookingScore ?? 0.5) +
      0.05 * (r.authorityScore ?? 0.5),
  }));

  const passing = candidates.filter(c => c.combinedScore >= SCORE_THRESHOLD);
  console.log(`[match "${term}"] score>=${SCORE_THRESHOLD}: ${passing.length} chunks`);
  if (passing.length === 0) return 0;

  // Load all Claims for passing chunks in one query — no LLM calls here
  const chunkById = new Map(passing.map(c => [c.id, c]));
  const claims = await db.claim.findMany({
    where: { chunkId: { in: [...chunkById.keys()] }, completeness: { gte: 0.4 }, specificity: { gte: 0.2 } },
    select: {
      id: true, chunkId: true, highlight: true, primarySubject: true,
      mentionedEntities: true, claimType: true, specificity: true,
      completeness: true, gloss: true, numbers: true,
    },
  });
  // Build highlight lookup for dedup pass below
  const claimHighlights = new Map<string, string>(claims.map(c => [c.id, c.highlight]));
  console.log(`[match "${term}"] claims loaded (comp>=0.4, spec>=0.2): ${claims.length}`);

  // Score each claim
  interface ScoredClaim {
    claimId: string; chunkId: string; episodeId: string; sourceId: string;
    score: number; entityWeight: number; quality: string;
    breakdown: {
      interestMatch: number; materiality: number; economicExposure: number;
      claimQuality: number; novelty: number; forwardLooking: number;
      numericInfo: number; specificity: number;
      claimTypeMultiplier: number; platitudePenalty: number;
    };
  }

  const scoredClaims: ScoredClaim[] = [];
  for (const claim of claims) {
    const chunk = chunkById.get(claim.chunkId);
    if (!chunk) continue;

    const entityWeight = computeEntityWeight(claim, expandedTokens);
    const numbers      = claim.numbers ?? [];

    const interestMatch    = Math.min(1, chunk.combinedScore);
    const materiality      = computeFinancialMaterialityScore(claim.highlight, numbers);
    const numericInfo      = computeNumericInformationScore(numbers, claim.highlight);
    const claimQuality     = Math.min(1, claim.completeness * claim.specificity * 1.5);
    const novelty          = chunk.noveltyScore ?? 0.5;
    const forwardLooking   = computeForwardLookingTextScore(claim.highlight, chunk.forwardLookingScore);
    const specificity      = claim.specificity;
    const economicExposure = computeEconomicExposureScore(claim, expandedTokens, materiality);
    const platitudePenalty = computePlatitudePenalty(claim.highlight);

    // Entity relevance is now a weighted component (15%), not a multiplier.
    // Materiality (22%) + economic exposure (15%) together outweigh entity alone.
    const investmentScore =
      0.20 * interestMatch    +
      0.22 * materiality      +
      0.15 * economicExposure +
      0.12 * claimQuality     +
      0.12 * novelty          +
      0.10 * forwardLooking   +
      0.07 * numericInfo      +
      0.02 * specificity;

    const claimTypeMultiplier = CLAIM_TYPE_MULTIPLIERS[claim.claimType] ?? 1.0;
    // relevanceGate: interestMatch must be meaningful — a great signal about the wrong topic scores near zero
    const relevanceGate = Math.pow(interestMatch, 1.5);
    // entityGate: if neither direct entity mention nor economic exposure is present, suppress heavily.
    // Prevents high-quality claims about unrelated topics from surfacing.
    // economicExposure handles subsidiaries (GitHub → Microsoft), so this doesn't break those cases.
    const entityRelevance = Math.max(entityWeight, economicExposure);
    // Graduated gate: entity must be central to the claim, not just semantically adjacent.
    // - >= 0.50: entity is primary subject OR subsidiary/topic term as primary/mentioned → full score
    // - >= 0.25: entity appears in highlight text → 60% (raised from 0.30 to catch borderline topic matches)
    // - < 0.25: semantic-only match → suppressed to near zero
    const entityGate = entityRelevance >= 0.50 ? 1.0 : entityRelevance >= 0.25 ? 0.60 : 0.10;
    const score = investmentScore * claimTypeMultiplier * (1 - platitudePenalty * 0.5) * relevanceGate * entityGate;

    const ideaTypes = new Set(['thesis', 'competitive', 'position']);
    const quality = ideaTypes.has(claim.claimType)
      ? 'idea'
      : (claim.completeness >= 0.5 ? 'high' : 'low');

    scoredClaims.push({
      claimId: claim.id, chunkId: claim.chunkId, episodeId: chunk.episodeId, sourceId: chunk.sourceId,
      score, entityWeight, quality,
      breakdown: {
        interestMatch, materiality, economicExposure, claimQuality, novelty,
        forwardLooking, numericInfo, specificity, claimTypeMultiplier, platitudePenalty,
      },
    });
  }

  console.log(`[match "${term}"] scored: ${scoredClaims.length} claims`);
  const top5 = [...scoredClaims].sort((a, b) => b.score - a.score).slice(0, 5);
  for (const sc of top5) {
    const b = sc.breakdown;
    console.log(
      `  score=${sc.score.toFixed(3)}  ew=${sc.entityWeight.toFixed(2)}` +
      `  eco=${b.economicExposure.toFixed(2)}  mat=${b.materiality.toFixed(2)}` +
      `  num=${b.numericInfo.toFixed(2)}  fwd=${b.forwardLooking.toFixed(2)}` +
      `  nov=${b.novelty.toFixed(2)}  type=${b.claimTypeMultiplier}x` +
      (b.platitudePenalty > 0 ? `  plat=-${(b.platitudePenalty * 0.5 * 100).toFixed(0)}%` : '')
    );
  }

  // Per-episode cap, ranked by score
  const byEpisode = new Map<string, ScoredClaim[]>();
  for (const sc of scoredClaims) {
    const list = byEpisode.get(sc.episodeId) ?? [];
    list.push(sc);
    byEpisode.set(sc.episodeId, list);
  }

  const toWrite: ScoredClaim[] = [];
  for (const [, list] of byEpisode) {
    list.sort((a, b) => b.score - a.score);
    toWrite.push(...list.slice(0, MAX_CLAIMS_PER_EPISODE));
  }

  // Per-source cap — prevents any single podcast from dominating when many episodes are ingested.
  // Sort globally by score so each source keeps its best claims across episodes.
  toWrite.sort((a, b) => b.score - a.score);
  const perSourceCount: Record<string, number> = {};
  const capped = toWrite.filter(sc => {
    const n = perSourceCount[sc.sourceId] ?? 0;
    if (n >= MAX_CLAIMS_PER_SOURCE) return false;
    perSourceCount[sc.sourceId] = n + 1;
    return true;
  });

  // Deduplicate near-identical claims (same episode, >70% word overlap) before writing.
  // Keeps only the highest-scoring version when boundary expansion produces
  // multiple overlapping highlights for the same underlying quote.
  const writtenHighlightsByEpisode = new Map<string, string[]>();
  // Per-primarySubject cap: prevents a single company/topic from dominating the feed.
  // E.g. limit "OpenAI" claims in an MSFT feed to avoid the Microsoft-OpenAI news
  // overwhelming direct MSFT signals.
  const MAX_CLAIMS_PER_SUBJECT = 3;
  const perSubjectCount: Record<string, number> = {};

  let written = 0;
  for (const sc of capped) {
    const highlight = claimHighlights.get(sc.claimId) ?? '';
    const prior = writtenHighlightsByEpisode.get(sc.episodeId) ?? [];
    if (prior.some(h => wordOverlapRatio(h, highlight) >= 0.70)) continue;

    // Subject cap: find the claim's primarySubject from the loaded claims array
    const claimObj = claims.find(c => c.id === sc.claimId);
    const subject = (claimObj?.primarySubject ?? '').toLowerCase().trim();
    if (subject) {
      const subjectHits = perSubjectCount[subject] ?? 0;
      if (subjectHits >= MAX_CLAIMS_PER_SUBJECT) continue;
      perSubjectCount[subject] = subjectHits + 1;
    }

    await db.interestMatch.upsert({
      where: { interestId_claimId: { interestId, claimId: sc.claimId } },
      update: { score: sc.score, entityWeight: sc.entityWeight, quality: sc.quality },
      create: {
        interestId,
        episodeId: sc.episodeId,
        chunkId: sc.chunkId,
        claimId: sc.claimId,
        score: sc.score,
        entityWeight: sc.entityWeight,
        quality: sc.quality,
      },
    });
    prior.push(highlight);
    writtenHighlightsByEpisode.set(sc.episodeId, prior);
    written++;
  }

  return written;
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

export async function backfillInterest(interestId: string, term: string): Promise<number> {
  return matchInterestAgainstEpisodes(interestId, term, null);
}

// ─── Pre-extraction ───────────────────────────────────────────────────────────
// Called at the end of ingestion. Decomposes all chunks into Claims so matching
// is fast (DB reads only, no LLM). Idempotent — skips chunks already extracted.

export async function preExtractEpisodeClaims(episodeId: string, sourceLanguage?: string): Promise<number> {
  const [chunks, episode] = await Promise.all([
    db.transcriptChunk.findMany({
      where: { episodeId },
      select: { id: true, text: true, chunkIndex: true, speakerLabel: true, speakerName: true },
    }),
    db.episode.findUnique({
      where: { id: episodeId },
      select: { title: true, source: { select: { name: true } } },
    }),
  ]);
  if (chunks.length === 0) return 0;

  // Build episode context string so the LLM can resolve "we"/"our" references
  const uniqueSpeakers = [...new Set(chunks.map(c => c.speakerName).filter(Boolean))];
  const episodeContext = episode
    ? `Episode: "${episode.title}" (${episode.source?.name ?? 'unknown podcast'}).${uniqueSpeakers.length > 0 ? ` Speakers: ${uniqueSpeakers.join(', ')}.` : ''}`
    : undefined;

  // Skip chunks that already have claims
  const existingChunkIds = new Set(
    (await db.claim.findMany({
      where: { chunkId: { in: chunks.map(c => c.id) } },
      select: { chunkId: true },
    })).map(c => c.chunkId)
  );

  const toProcess = chunks.filter(c => !existingChunkIds.has(c.id));
  console.log(`[preExtract] episode ${episodeId}: ${chunks.length} total chunks, ${existingChunkIds.size} already extracted, ${toProcess.length} to process`);

  const limiter = pLimit(CLAIM_CONCURRENCY);
  const results = await Promise.all(
    toProcess.map(c => limiter(() => extractAllClaims(c.id, c.text, {
      episodeId,
      chunkIndex: c.chunkIndex,
      speakerLabel: c.speakerLabel ?? null,
      episodeContext,
      sourceLanguage,
    })))
  );

  const total = results.reduce((sum, r) => sum + r.length, 0);
  console.log(`[preExtract] episode ${episodeId}: done — ${total} claims from ${toProcess.length} chunks`);
  return total;
}

// ─── Post-ingest trigger ──────────────────────────────────────────────────────

export async function matchEpisodeAgainstAllInterests(episodeId: string): Promise<void> {
  const interests = await db.userInterest.findMany({ where: { userId: 'default' } });
  for (const interest of interests) {
    await matchInterestAgainstEpisodes(interest.id, interest.term, [episodeId]);
  }
}
