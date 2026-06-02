/**
 * scripts/audit-interest.ts
 *
 * Produces a before/after ranking report for a given interest.
 * "Before" = current stored InterestMatch.score (old algorithm).
 * "After"  = recomputed score using current engine logic.
 *
 * No DB writes — read-only audit.
 *
 * Usage:
 *   npm run audit-interest -- --interest "Microsoft"
 *   npm run audit-interest -- --interest "Microsoft" --top 30
 */

import '../src/lib/worker/env';
import { db } from '../src/lib/db';

// ─── Scoring helpers (mirrors engine.ts) ─────────────────────────────────────

const ECONOMIC_SUBSIDIARIES: Record<string, string[]> = {
  microsoft:  ['azure', 'github', 'copilot', 'office', '365', 'linkedin', 'windows', 'teams', 'dynamics', 'bing', 'xbox', 'activision', 'nuance', 'openai'],
  google:     ['youtube', 'deepmind', 'waymo', 'google cloud', 'gemini', 'android', 'chrome', 'alphabet'],
  amazon:     ['aws', 'prime', 'alexa', 'twitch', 'ring', 'whole foods', 'audible'],
  apple:      ['app store', 'icloud', 'siri', 'apple pay', 'iphone', 'mac', 'ipad', 'vision pro'],
  meta:       ['instagram', 'whatsapp', 'reality labs', 'llama', 'threads', 'facebook', 'oculus'],
  nvidia:     ['cuda', 'h100', 'h200', 'b200', 'hopper', 'blackwell', 'nemo', 'nim', 'dgx'],
  openai:     ['chatgpt', 'gpt', 'dall-e', 'sora', 'o1', 'o3'],
  anthropic:  ['claude', 'sonnet', 'haiku', 'opus'],
  tesla:      ['fsd', 'dojo', 'megapack', 'powerwall', 'supercharger', 'optimus'],
  salesforce: ['slack', 'tableau', 'mulesoft', 'einstein', 'agentforce'],
};

const CLAIM_TYPE_MULTIPLIERS: Record<string, number> = {
  guidance: 2.0, growth: 1.8, unit_economics: 1.8, transaction: 1.6,
  valuation: 1.5, competitive: 1.3, position: 1.0, thesis: 0.8,
};

const MATERIALITY_PATTERNS: { re: RegExp; pts: number }[] = [
  { re: /\b(revenue|ARR|MRR|bookings?|run rate|recurring)\b/i,                         pts: 0.18 },
  { re: /\b(margin|gross margin|operating margin|EBITDA|profitab)\b/i,                  pts: 0.18 },
  { re: /\b(growth rate|CAGR|YoY|QoQ|grew|growing|grown)\b/i,                          pts: 0.14 },
  { re: /\b(TAM|market size|market share|addressable|penetration)\b/i,                  pts: 0.14 },
  { re: /\b(CapEx|capital expenditure|acquisition|buyback)\b/i,                         pts: 0.12 },
  { re: /\b(valuation|multiple|P\/E|EV|price.?target)\b/i,                              pts: 0.14 },
  { re: /\b(unit economics?|inference cost|token cost|cost per|pricing)\b/i,            pts: 0.14 },
  { re: /\b(projected?|forecast|guidance|expected?|by 20\d\d|next year|long.?term|outlook)\b/i, pts: 0.10 },
];

const LARGE_DOLLAR_RE = /\$\s*[\d,.]+\s*[TB]/i;
const MID_DOLLAR_RE   = /\$\s*[\d,.]+\s*[MB]/i;
const PCT_METRIC_RE   = /\d+\.?\d*\s*%/;
const FUTURE_YEAR_RE  = /\b(202[5-9]|203\d)\b/;

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

function matchesToken(text: string, token: string): boolean {
  try {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  } catch { return false; }
}

function getSubsidiaries(termTokens: string[]): string[] {
  for (const [parent, subs] of Object.entries(ECONOMIC_SUBSIDIARIES)) {
    if (termTokens.some(t => t.toLowerCase() === parent || parent.includes(t.toLowerCase()))) return subs;
  }
  return [];
}

function isSubsidiaryMatch(entity: string, subsidiaries: string[]): boolean {
  const lower = entity.toLowerCase();
  return subsidiaries.some(sub => lower.includes(sub) || sub.includes(lower));
}

function computeEntityWeight(claim: { primarySubject: string | null; mentionedEntities: string[]; claimType: string; highlight: string }, termTokens: string[]): number {
  if (claim.primarySubject && termTokens.some(t => matchesToken(claim.primarySubject!, t))) return 1.0;
  const mentioned = claim.mentionedEntities.some(e => termTokens.some(t => matchesToken(e, t)));
  if (mentioned) return claim.claimType === 'transaction' ? 0.8 : 0.3;
  if (termTokens.some(t => matchesToken(claim.highlight, t))) return 0.2;
  return 0.1;
}

function computeMateriality(highlight: string, numbers: string[]): number {
  let score = 0; let hits = 0;
  for (const { re, pts } of MATERIALITY_PATTERNS) { if (re.test(highlight)) { score += pts; hits++; } }
  const combined = numbers.join(' ') + ' ' + highlight;
  if (LARGE_DOLLAR_RE.test(combined)) score += 0.30;
  else if (MID_DOLLAR_RE.test(combined)) score += 0.18;
  if (PCT_METRIC_RE.test(combined)) score += 0.10;
  if (FUTURE_YEAR_RE.test(combined)) score += 0.07;
  if (hits > 0 && numbers.length > 0) score += 0.12;
  return Math.min(1.0, score);
}

function computeNumericInfo(numbers: string[], highlight: string): number {
  if (numbers.length === 0 && !PCT_METRIC_RE.test(highlight)) return 0.05;
  let score = Math.min(0.40, numbers.length * 0.13);
  const combined = numbers.join(' ') + ' ' + highlight;
  if (LARGE_DOLLAR_RE.test(combined)) score += 0.40;
  else if (MID_DOLLAR_RE.test(combined)) score += 0.22;
  if (PCT_METRIC_RE.test(combined)) score += 0.18;
  if (FUTURE_YEAR_RE.test(combined)) score += 0.10;
  return Math.min(1.0, score);
}

function computeEconomicExposure(claim: { primarySubject: string | null; mentionedEntities: string[]; highlight: string }, termTokens: string[], materiality: number): number {
  const subsidiaries = getSubsidiaries(termTokens);
  const allEntities  = [...(claim.primarySubject ? [claim.primarySubject] : []), ...claim.mentionedEntities];
  if (claim.primarySubject && termTokens.some(t => matchesToken(claim.primarySubject!, t)))
    return materiality > 0.2 ? 1.0 : 0.65;
  if (subsidiaries.length > 0 && claim.primarySubject && isSubsidiaryMatch(claim.primarySubject, subsidiaries))
    return materiality > 0.3 ? 0.90 : 0.55;
  if (allEntities.some(e => termTokens.some(t => matchesToken(e, t))))
    return materiality > 0.2 ? 0.50 : 0.35;
  if (subsidiaries.length > 0 && allEntities.some(e => isSubsidiaryMatch(e, subsidiaries)))
    return materiality > 0.3 ? 0.45 : 0.25;
  if (termTokens.some(t => matchesToken(claim.highlight, t))) return 0.25;
  return 0.15;
}

function computePlatitudePenalty(highlight: string): number {
  let hits = 0;
  for (const re of PLATITUDE_PATTERNS) { if (re.test(highlight)) hits++; }
  return Math.min(0.60, hits * 0.20);
}

function computeForwardScore(highlight: string, chunkScore: number | null): number {
  const base  = chunkScore ?? 0.5;
  const bonus = MATERIALITY_PATTERNS[7].re.test(highlight) ? 0.25 : 0;
  return Math.min(1.0, base + bonus);
}

// ─── Score formulas ───────────────────────────────────────────────────────────

function oldScore(params: {
  combinedScore: number; materiality: number; numericInfo: number;
  claimQuality: number; novelty: number; forwardLooking: number; specificity: number;
  entityWeight: number; claimTypeMultiplier: number;
}): number {
  const investmentScore =
    0.25 * Math.min(1, params.combinedScore) +
    0.20 * params.materiality +
    0.15 * params.claimQuality +
    0.15 * params.novelty +
    0.10 * params.forwardLooking +
    0.10 * params.numericInfo +
    0.05 * params.specificity;
  const entityBoost = 0.85 + params.entityWeight * 0.30;
  return investmentScore * params.claimTypeMultiplier * entityBoost;
}

function newScore(params: {
  combinedScore: number; materiality: number; numericInfo: number;
  claimQuality: number; novelty: number; forwardLooking: number; specificity: number;
  economicExposure: number; platitudePenalty: number; claimTypeMultiplier: number;
}): number {
  const investmentScore =
    0.20 * Math.min(1, params.combinedScore) +
    0.22 * params.materiality +
    0.15 * params.economicExposure +
    0.12 * params.claimQuality +
    0.12 * params.novelty +
    0.10 * params.forwardLooking +
    0.07 * params.numericInfo +
    0.02 * params.specificity;
  return investmentScore * params.claimTypeMultiplier * (1 - params.platitudePenalty * 0.5);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const get  = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

  const interestTerm = get('--interest') ?? '';
  const topN         = parseInt(get('--top') ?? '20');

  if (!interestTerm) { console.error('Usage: npm run audit-interest -- --interest "<term>"'); process.exit(1); }

  const interest = await db.userInterest.findFirst({
    where: { term: { equals: interestTerm, mode: 'insensitive' } },
    select: { id: true, term: true },
  });
  if (!interest) { console.error(`No interest found matching "${interestTerm}"`); process.exit(1); }

  const termTokens = interestTerm.toLowerCase().split(/\s+/).filter(Boolean);
  console.log(`\nAudit: "${interest.term}" — tokens: [${termTokens.join(', ')}]\n`);

  const rows = await db.interestMatch.findMany({
    where: { interestId: interest.id },
    orderBy: { score: 'desc' },
    select: {
      score: true, entityWeight: true, quality: true,
      claim: {
        select: {
          highlight: true, claimType: true, specificity: true, completeness: true,
          primarySubject: true, mentionedEntities: true, numbers: true,
        },
      },
      chunk: {
        select: { noveltyScore: true, convictionScore: true, importanceScore: true, relevanceScore: true },
      },
      episode: { select: { title: true, publishedAt: true } },
    },
  });

  if (rows.length === 0) { console.log('No matches found. Run Re-scan first.'); process.exit(0); }

  // Compute new scores for all rows
  type Scored = {
    oldRank: number; newRank: number; oldScoreVal: number; newScoreVal: number;
    delta: number; highlight: string; claimType: string; primarySubject: string | null;
    mat: number; eco: number; num: number; fwd: number; nov: number; plat: number; ew: number;
    episodeTitle: string;
  };

  const scored: Scored[] = rows.map((row, i) => {
    const c        = row.claim;
    const chunk    = row.chunk;
    const numbers  = c.numbers ?? [];
    const mat      = computeMateriality(c.highlight, numbers);
    const numInfo  = computeNumericInfo(numbers, c.highlight);
    const ew       = computeEntityWeight(c, termTokens);
    const novelty  = chunk.noveltyScore ?? 0.5;
    const fwd      = computeForwardScore(c.highlight, chunk.convictionScore);
    const quality  = Math.min(1, c.completeness * c.specificity * 1.5);
    const eco      = computeEconomicExposure(c, termTokens, mat);
    const plat     = computePlatitudePenalty(c.highlight);
    const typeM    = CLAIM_TYPE_MULTIPLIERS[c.claimType] ?? 1.0;

    // Approximate combined chunk score (we don't have vector similarity at audit time)
    const approxCombined = 0.35 + 0.20 * (chunk.importanceScore ?? 0.5) + 0.15 * (chunk.convictionScore ?? 0.5) + 0.05 * (chunk.relevanceScore ?? 0.5);

    const old = oldScore({ combinedScore: approxCombined, materiality: mat, numericInfo: numInfo, claimQuality: quality, novelty, forwardLooking: fwd, specificity: c.specificity, entityWeight: ew, claimTypeMultiplier: typeM });
    const nw  = newScore({ combinedScore: approxCombined, materiality: mat, numericInfo: numInfo, claimQuality: quality, novelty, forwardLooking: fwd, specificity: c.specificity, economicExposure: eco, platitudePenalty: plat, claimTypeMultiplier: typeM });

    return {
      oldRank: i + 1, newRank: 0, oldScoreVal: old, newScoreVal: nw,
      delta: nw - old,
      highlight: c.highlight, claimType: c.claimType,
      primarySubject: c.primarySubject, mat, eco, num: numInfo, fwd, nov: novelty, plat, ew,
      episodeTitle: row.episode?.title ?? '?',
    };
  });

  // Assign new ranks
  const byNew = [...scored].sort((a, b) => b.newScoreVal - a.newScoreVal);
  byNew.forEach((r, i) => { r.newRank = i + 1; });

  const W = 130;
  console.log(`${'═'.repeat(W)}`);
  console.log(`  OLD RANKING  (top ${topN})`);
  console.log(`${'═'.repeat(W)}`);
  console.log(`  ${'#'.padEnd(4)}  ${'old'.padEnd(6)}  ${'new'.padEnd(6)}  ${'Δrank'.padEnd(7)}  ${'type'.padEnd(16)}  ${'mat'.padEnd(5)}  ${'eco'.padEnd(5)}  ${'num'.padEnd(5)}  ${'plat'.padEnd(5)}  highlight`);
  console.log(`  ${'─'.repeat(W - 2)}`);

  const oldSorted = [...scored].sort((a, b) => b.oldScoreVal - a.oldScoreVal).slice(0, topN);
  for (const r of oldSorted) {
    const deltaRank = r.oldRank - r.newRank;
    const deltaStr  = deltaRank > 0 ? `↑${deltaRank}` : deltaRank < 0 ? `↓${Math.abs(deltaRank)}` : `=`;
    const preview   = r.highlight.replace(/\s+/g, ' ').slice(0, 80) + (r.highlight.length > 80 ? '…' : '');
    const plat      = r.plat > 0 ? `-${(r.plat * 50).toFixed(0)}%` : '—    ';
    console.log(`  ${r.oldRank.toString().padEnd(4)}  ${r.oldScoreVal.toFixed(3).padEnd(6)}  ${r.newScoreVal.toFixed(3).padEnd(6)}  ${deltaStr.padEnd(7)}  ${r.claimType.padEnd(16)}  ${r.mat.toFixed(2).padEnd(5)}  ${r.eco.toFixed(2).padEnd(5)}  ${r.num.toFixed(2).padEnd(5)}  ${plat.padEnd(5)}  ${preview}`);
  }

  console.log(`\n${'═'.repeat(W)}`);
  console.log(`  NEW RANKING  (top ${topN}) — after re-scan`);
  console.log(`${'═'.repeat(W)}`);
  console.log(`  ${'#'.padEnd(4)}  ${'new'.padEnd(6)}  ${'old'.padEnd(6)}  ${'Δrank'.padEnd(7)}  ${'type'.padEnd(16)}  ${'mat'.padEnd(5)}  ${'eco'.padEnd(5)}  ${'num'.padEnd(5)}  ${'plat'.padEnd(5)}  highlight`);
  console.log(`  ${'─'.repeat(W - 2)}`);

  for (const r of byNew.slice(0, topN)) {
    const deltaRank = r.oldRank - r.newRank;
    const deltaStr  = deltaRank > 0 ? `↑${deltaRank}` : deltaRank < 0 ? `↓${Math.abs(deltaRank)}` : `=`;
    const preview   = r.highlight.replace(/\s+/g, ' ').slice(0, 80) + (r.highlight.length > 80 ? '…' : '');
    const plat      = r.plat > 0 ? `-${(r.plat * 50).toFixed(0)}%` : '—    ';
    console.log(`  ${r.newRank.toString().padEnd(4)}  ${r.newScoreVal.toFixed(3).padEnd(6)}  ${r.oldScoreVal.toFixed(3).padEnd(6)}  ${deltaStr.padEnd(7)}  ${r.claimType.padEnd(16)}  ${r.mat.toFixed(2).padEnd(5)}  ${r.eco.toFixed(2).padEnd(5)}  ${r.num.toFixed(2).padEnd(5)}  ${plat.padEnd(5)}  ${preview}`);
  }

  // Biggest movers summary
  const biggestUp   = [...scored].sort((a, b) => (a.newRank - a.oldRank) - (b.newRank - b.oldRank)).slice(0, 5);
  const biggestDown = [...scored].sort((a, b) => (b.newRank - b.oldRank) - (a.newRank - a.oldRank)).slice(0, 5);

  console.log(`\n${'─'.repeat(W)}`);
  console.log(`  BIGGEST RISES`);
  console.log(`${'─'.repeat(W)}`);
  for (const r of biggestUp) {
    const mv = r.oldRank - r.newRank;
    if (mv <= 0) continue;
    const why = [
      r.mat > 0.3 ? `mat=${r.mat.toFixed(2)}` : '',
      r.eco > 0.7 ? `eco=${r.eco.toFixed(2)}` : '',
      r.num > 0.4 ? `num=${r.num.toFixed(2)}` : '',
      r.fwd > 0.7 ? `fwd=${r.fwd.toFixed(2)}` : '',
    ].filter(Boolean).join(', ');
    console.log(`  #${r.oldRank} → #${r.newRank} (+${mv})  [${r.claimType}]  why: ${why || 'lower entity dominance'}`);
    console.log(`    "${r.highlight.replace(/\s+/g, ' ').slice(0, 100)}"`);
  }

  console.log(`\n${'─'.repeat(W)}`);
  console.log(`  BIGGEST FALLS`);
  console.log(`${'─'.repeat(W)}`);
  for (const r of biggestDown) {
    const mv = r.newRank - r.oldRank;
    if (mv <= 0) continue;
    const why = [
      r.plat > 0 ? `platitude=-${(r.plat * 50).toFixed(0)}%` : '',
      r.mat < 0.1 ? 'no materiality' : '',
      r.num < 0.1 ? 'no numbers' : '',
    ].filter(Boolean).join(', ');
    console.log(`  #${r.oldRank} → #${r.newRank} (-${mv})  [${r.claimType}]  why: ${why || 'entity weight reduced'}`);
    console.log(`    "${r.highlight.replace(/\s+/g, ' ').slice(0, 100)}"`);
  }

  console.log(`\n${'═'.repeat(W)}\n`);
  await db.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
