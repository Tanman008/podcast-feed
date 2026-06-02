/**
 * scripts/inspect-claims.ts
 *
 * Dumps extracted claims with final match scores and component breakdowns.
 *
 * Usage:
 *   npm run inspect-claims
 *   npm run inspect-claims -- --episode <id>
 *   npm run inspect-claims -- --interest "Microsoft"
 *   npm run inspect-claims -- --interest "Microsoft" --debug
 *   npm run inspect-claims -- --min-spec 0.5 --min-comp 0.6
 *   npm run inspect-claims -- --type growth,guidance
 */

import '../src/lib/worker/env';
import { db } from '../src/lib/db';

// ─── Scoring helpers (mirrors engine.ts) ─────────────────────────────────────

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

const CLAIM_TYPE_MULTIPLIERS: Record<string, number> = {
  guidance: 2.0, growth: 1.8, unit_economics: 1.8, transaction: 1.6,
  valuation: 1.5, competitive: 1.3, position: 1.0, thesis: 0.8,
};

function computeFinancialMaterialityScore(highlight: string, numbers: string[]): number {
  let score = 0; let categoryHits = 0;
  for (const { re, pts } of MATERIALITY_PATTERNS) {
    if (re.test(highlight)) { score += pts; categoryHits++; }
  }
  const combined = numbers.join(' ') + ' ' + highlight;
  if (LARGE_DOLLAR_RE.test(combined)) score += 0.30;
  else if (MID_DOLLAR_RE.test(combined)) score += 0.18;
  if (PCT_METRIC_RE.test(combined)) score += 0.10;
  if (FUTURE_YEAR_RE.test(combined)) score += 0.07;
  if (categoryHits > 0 && numbers.length > 0) score += 0.12;
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

function countSentences(text: string): number {
  return (text.match(/[.!?](?:\s+[A-Z"']|\s*$)/g) ?? []).length;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const get  = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

  const episodeId    = get('--episode');
  const interestTerm = get('--interest');
  const minSpec      = parseFloat(get('--min-spec') ?? '0');
  const minComp      = parseFloat(get('--min-comp') ?? '0');
  const typeFilter   = get('--type')?.split(',') ?? null;
  const debug        = args.includes('--debug');

  let interestId: string | null = null;
  if (interestTerm) {
    const interest = await db.userInterest.findFirst({
      where: { term: { equals: interestTerm, mode: 'insensitive' } },
      select: { id: true, term: true },
    });
    if (!interest) { console.error(`No interest found matching "${interestTerm}"`); process.exit(1); }
    interestId = interest.id;
    console.log(`\nFiltering by interest: ${interest.term} (${interestId})`);
  }

  const episodes = await db.episode.findMany({
    where: { transcriptStatus: 'completed', ...(episodeId ? { id: episodeId } : {}) },
    select: { id: true, title: true, publishedAt: true },
    orderBy: { publishedAt: 'desc' },
  });

  let shown = 0;

  for (const ep of episodes) {
    const claims = await db.claim.findMany({
      where: {
        chunk: { episodeId: ep.id },
        specificity: { gte: minSpec },
        completeness: { gte: minComp },
        ...(typeFilter ? { claimType: { in: typeFilter } } : {}),
      },
      select: {
        id: true, highlight: true, claimType: true, specificity: true,
        completeness: true, primarySubject: true, numbers: true,
        mentionedEntities: true,
        chunk: { select: { noveltyScore: true, convictionScore: true } },
        interestMatches: {
          where: interestId ? { interestId } : {},
          select: { score: true, entityWeight: true, quality: true },
          orderBy: { score: 'desc' },
          take: 1,
        },
      },
    });

    if (claims.length === 0) continue;

    // Sort by match score desc, then by recomputed materiality
    claims.sort((a, b) => {
      const sa = a.interestMatches[0]?.score ?? -1;
      const sb = b.interestMatches[0]?.score ?? -1;
      return sb - sa;
    });

    shown += claims.length;
    const date = ep.publishedAt ? ep.publishedAt.toISOString().slice(0, 10) : 'no-date';
    console.log(`\n${'─'.repeat(130)}`);
    console.log(`  ${ep.title}  [${date}]  (${claims.length} claims)`);
    console.log(`${'─'.repeat(130)}`);

    if (debug) {
      console.log(`  ${'score'.padEnd(6)}  ${'ew'.padEnd(4)}  ${'mat'.padEnd(4)}  ${'num'.padEnd(4)}  ${'fwd'.padEnd(4)}  ${'nov'.padEnd(4)}  ${'type'.padEnd(16)}  ${'q'.padEnd(5)}  highlight`);
    } else {
      console.log(`  ${'score'.padEnd(6)}  ${'quality'.padEnd(7)}  ${'ew'.padEnd(4)}  ${'sent'.padEnd(4)}  ${'type'.padEnd(16)}  ${'spec'.padEnd(5)}  ${'comp'.padEnd(5)}  ${'nums'.padEnd(4)}  highlight`);
    }
    console.log(`  ${'─'.repeat(126)}`);

    for (const c of claims) {
      const match   = c.interestMatches[0];
      const score   = match ? match.score.toFixed(3) : '—    ';
      const quality = match?.quality ?? '—';
      const ew      = match ? match.entityWeight.toFixed(2) : '—   ';
      const sent    = countSentences(c.highlight);
      const nums    = c.numbers.length;
      const type    = c.claimType.padEnd(16);
      const preview = c.highlight.replace(/\s+/g, ' ').slice(0, 100) + (c.highlight.length > 100 ? '…' : '');
      const flag    = sent < 2 ? ' ⚠ ' : '   ';

      if (debug) {
        const mat = computeFinancialMaterialityScore(c.highlight, c.numbers).toFixed(2);
        const num = computeNumericInformationScore(c.numbers, c.highlight).toFixed(2);
        const nov = (c.chunk?.noveltyScore ?? 0.5).toFixed(2);
        const fwd = (c.chunk?.convictionScore ?? 0.5).toFixed(2);
        const typeM = (CLAIM_TYPE_MULTIPLIERS[c.claimType] ?? 1.0).toFixed(1);
        console.log(`${flag}${score.padEnd(6)}  ${ew.padEnd(4)}  ${mat.padEnd(4)}  ${num.padEnd(4)}  ${fwd.padEnd(4)}  ${nov.padEnd(4)}  ${type}  ${quality.padEnd(5)}  ${preview}`);
      } else {
        console.log(`${flag}${score.padEnd(6)}  ${quality.padEnd(7)}  ${ew.padEnd(4)}  ${sent.toString().padEnd(4)}  ${type}  ${c.specificity.toFixed(2).padEnd(5)}  ${c.completeness.toFixed(2).padEnd(5)}  ${nums.toString().padEnd(4)}  ${preview}`);
      }
      if (nums > 0) {
        const indent = debug ? '                                    ' : '                                          ';
        console.log(`${indent}numbers: ${c.numbers.join(' · ')}`);
      }
    }
  }

  console.log(`\n${'═'.repeat(130)}`);
  console.log(`  ${shown} claims across ${episodes.length} episodes`);
  if (!interestId) console.log(`  Tip: use --interest "<term>" to see scores, --debug for component breakdown`);
  console.log(`${'═'.repeat(130)}\n`);

  await db.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
