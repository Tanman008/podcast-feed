'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { TranscriptModal } from './TranscriptModal';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DigestData {
  todayCount: number;
  weekCount: number;
  searchTerm: string;
  generatedAt: string;
}

interface Match {
  id: string;
  score: number;
  entityWeight: number;
  quality: string | null;
  createdAt: string;
  sourceFollowed: boolean;
  claim: {
    id: string;
    highlight: string;
    primarySubject: string | null;
    mentionedEntities: string[];
    claimType: string;
    specificity: number;
    completeness: number;
    gloss: string | null;
    numbers: string[];
  };
  episode: {
    id: string;
    externalId: string;
    title: string;
    publishedAt: string | null;
    source: { name: string; platform: string } | null;
  };
  chunk: {
    id: string;
    startTimeSeconds: number;
    endTimeSeconds: number;
    text: string;
    speakerLabel: string | null;
    speakerName: string | null;
    authorityScore: number | null;
    keyPhrase: string | null;
  };
}

interface Interest {
  id: string;
  term: string;
  _count: { matches: number };
}

interface Source { id: string; name: string }
interface MonthBucket { month: string; count: number }

interface Filters {
  convictionMin: number;
  noveltyMin: number;
  minRelevance: number;
  chunksPerEpisode: number;
  dateRange: [number, number];
  sourceIds: string[];
  showContext: boolean;
  followedOnly: boolean;
}

type ViewMode = 'by_interest' | 'by_podcast' | 'combined';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONO = 'font-[family-name:var(--font-inter)]';

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function fmtMonth(m: string) {
  const [y, mo] = m.split('-');
  return new Date(parseInt(y), parseInt(mo) - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function matchQualityLabel(score: number): string {
  if (score >= 0.40) return 'Best';
  if (score >= 0.28) return 'Strong';
  if (score >= 0.18) return 'Good';
  if (score >= 0.10) return 'Fair';
  return 'Any';
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? [text]).map(s => s.trim()).filter(s => s.length > 8);
}

function extractContext(text: string, highlight: string): { before: string; after: string } {
  const sentences = splitSentences(text);
  const hlLower = highlight.toLowerCase();

  // Find sentence containing the START of the highlight
  const startNeedle = hlLower.slice(0, 40);
  let startIdx = sentences.findIndex(s => s.toLowerCase().includes(startNeedle));
  if (startIdx === -1) startIdx = sentences.findIndex(s => s.toLowerCase().includes(hlLower.slice(0, 20)));
  if (startIdx === -1) return { before: '', after: '' };

  // Find sentence containing the END of the highlight (last 40 chars)
  const endNeedle = hlLower.slice(-40).trim();
  let endIdx = sentences.findIndex((s, i) => i >= startIdx && s.toLowerCase().includes(endNeedle));
  if (endIdx === -1) endIdx = startIdx;

  return {
    before: sentences.slice(Math.max(0, startIdx - 1), startIdx).join(' '),
    after: sentences.slice(endIdx + 1, endIdx + 2).join(' '),
  };
}

function HighlightText({ text, phrase }: { text: string; phrase: string | null }) {
  if (!phrase) return <span>{text}</span>;
  try {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`\\b${escaped}\\b`, 'i').exec(text);
    if (!m) return <span>{text}</span>;
    return (
      <span>
        {text.slice(0, m.index)}
        <span className="underline decoration-[#C8900A]/60 decoration-2 underline-offset-2">
          {text.slice(m.index, m.index + phrase.length)}
        </span>
        {text.slice(m.index + phrase.length)}
      </span>
    );
  } catch {
    return <span>{text}</span>;
  }
}

// ─── Histogram date slider ────────────────────────────────────────────────────

function HistogramSlider({
  buckets,
  value,
  onChange,
}: {
  buckets: MonthBucket[];
  value: [number, number];
  onChange: (r: [number, number]) => void;
}) {
  const n = buckets.length;
  const maxCount = Math.max(...buckets.map(b => b.count), 1);
  const [lo, hi] = value;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'lo' | 'hi' | null>(null);

  if (n === 0) return <div className={`text-[10px] text-[#777] ${MONO}`}>No data</div>;

  // Single month: no range to select, just show the label
  if (n === 1) return (
    <div className={`text-[10px] text-[#777] ${MONO}`}>{fmtMonth(buckets[0].month)}</div>
  );

  const loFrac = lo / (n - 1);
  const hiFrac = hi / (n - 1);

  function idxFromPointer(e: React.PointerEvent | PointerEvent) {
    const rect = trackRef.current!.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return Math.round(frac * (n - 1));
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const idx = idxFromPointer(e);
    const closer = Math.abs(idx - lo) <= Math.abs(idx - hi) ? 'lo' : 'hi';
    dragging.current = closer;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    if (closer === 'lo') onChange([Math.min(idx, hi), hi]);
    else onChange([lo, Math.max(idx, lo)]);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const idx = idxFromPointer(e);
    if (dragging.current === 'lo') onChange([Math.min(idx, hi), hi]);
    else onChange([lo, Math.max(idx, lo)]);
  }

  function handlePointerUp() { dragging.current = null; }

  return (
    <div className="select-none">
      {/* Histogram bars */}
      <svg
        viewBox={`0 0 ${n} 32`}
        preserveAspectRatio="none"
        className="w-full h-8 mb-1"
      >
        {buckets.map((b, i) => {
          const h = Math.max(2, (b.count / maxCount) * 30);
          const inRange = i >= lo && i <= hi;
          return (
            <rect
              key={i}
              x={i + 0.1}
              y={32 - h}
              width={0.8}
              height={h}
              fill={inRange ? '#C8900A' : '#2a2a2a'}
              rx={0.2}
            />
          );
        })}
      </svg>

      {/* Dual range slider — pointer-events on container, not pseudo-elements (Safari-safe) */}
      <div
        ref={trackRef}
        className="relative h-4 cursor-pointer"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Base track */}
        <div className="range-slider-track" />
        {/* Active track between handles */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-[2px] bg-[#C8900A] pointer-events-none"
          style={{ left: `${loFrac * 100}%`, right: `${(1 - hiFrac) * 100}%` }}
        />
        {/* Lo handle */}
        <div
          className="absolute top-1/2 w-[11px] h-[11px] rounded-full bg-[#C8900A] border-2 border-[#0a0a0a] pointer-events-none"
          style={{ left: `${loFrac * 100}%`, transform: 'translate(-50%, -50%)', boxShadow: '0 0 0 1px #C8900A' }}
        />
        {/* Hi handle */}
        <div
          className="absolute top-1/2 w-[11px] h-[11px] rounded-full bg-[#C8900A] border-2 border-[#0a0a0a] pointer-events-none"
          style={{ left: `${hiFrac * 100}%`, transform: 'translate(-50%, -50%)', boxShadow: '0 0 0 1px #C8900A' }}
        />
      </div>

      {/* Labels */}
      <div className={`flex justify-between mt-2 text-[9px] text-[#999] ${MONO}`}>
        <span>{fmtMonth(buckets[lo]?.month ?? '')}</span>
        <span>{fmtMonth(buckets[hi]?.month ?? '')}</span>
      </div>
    </div>
  );
}

// ─── Collapsible sidebar section ──────────────────────────────────────────────

function SidebarSection({ label, children, defaultOpen = true }: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between text-[9px] uppercase tracking-widest mb-2.5 ${MONO} text-[#aaa] hover:text-[#ddd] transition-colors`}
      >
        <span className="font-semibold">{label}</span>
        <span className="text-[#555]">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="mb-2">{children}</div>}
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar({
  filters,
  setFilters,
  viewMode,
  setViewMode,
  sources,
  buckets,
  onApply,
  open,
  onClose,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  onApply: () => void;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  sources: Source[];
  buckets: MonthBucket[];
  open: boolean;
  onClose: () => void;
}) {
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });

  const toggleSource = (id: string) => {
    const next = filters.sourceIds.includes(id)
      ? filters.sourceIds.filter(s => s !== id)
      : [...filters.sourceIds, id];
    set({ sourceIds: next });
  };

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={onClose} />
      )}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 md:relative md:inset-auto md:z-auto md:w-52 shrink-0 bg-[#080808] border-r border-[#181818] flex flex-col py-5 px-4 md:h-screen md:sticky md:top-0 overflow-y-auto transform transition-transform duration-200 ease-out ${open ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}>
        <button
          onClick={onClose}
          className="md:hidden self-end mb-2 text-[#555] hover:text-[#aaa] text-base leading-none"
          aria-label="Close filters"
        >✕</button>

      <SidebarSection label="View">
        <div className={`flex rounded border border-[#232323] overflow-hidden ${MONO} text-[9px]`}>
          {([
            ['by_interest', 'Interest'],
            ['by_podcast',  'Podcast'],
            ['combined',    'Combined'],
          ] as [ViewMode, string][]).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`flex-1 py-1.5 text-center uppercase tracking-wider transition-colors ${
                viewMode === m
                  ? 'bg-[#C8900A] text-black font-bold'
                  : 'text-[#666] hover:text-[#ccc] hover:bg-[#111]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </SidebarSection>

      <SidebarSection label="Context">
        <button
          onClick={() => set({ showContext: !filters.showContext })}
          className="flex items-center gap-2"
        >
          <span className={`w-8 h-4 rounded-full flex items-center transition-colors shrink-0 ${filters.showContext ? 'bg-[#C8900A]' : 'bg-[#1e1e1e]'}`}>
            <span className={`w-3 h-3 rounded-full bg-black ml-0.5 transition-transform ${filters.showContext ? 'translate-x-4' : ''}`} />
          </span>
          <span className="text-xs text-[#999]">Show context</span>
        </button>
      </SidebarSection>

      <SidebarSection label="Source">
        <button
          onClick={() => set({ followedOnly: !filters.followedOnly })}
          className="flex items-center gap-2"
        >
          <span className={`w-8 h-4 rounded-full flex items-center transition-colors shrink-0 ${filters.followedOnly ? 'bg-[#22c55e]' : 'bg-[#1e1e1e]'}`}>
            <span className={`w-3 h-3 rounded-full bg-black ml-0.5 transition-transform ${filters.followedOnly ? 'translate-x-4' : ''}`} />
          </span>
          <span className="text-xs text-[#999]">Following only</span>
        </button>
      </SidebarSection>

      <SidebarSection label="Match quality">
        <div className="flex items-center gap-2 mb-1">
          <input
            type="range" min={0} max={0.55} step={0.03}
            value={filters.minRelevance ?? 0}
            onChange={e => set({ minRelevance: parseFloat(e.target.value) })}
            className="flex-1 h-1 rounded-full appearance-none cursor-pointer bg-[#1e1e1e] accent-[#C8900A]"
          />
          <span className={`text-[10px] text-[#C8900A] w-16 text-right shrink-0 ${MONO}`}>
            {matchQualityLabel(filters.minRelevance ?? 0)}
          </span>
        </div>
        <div className={`flex justify-between text-[8px] text-[#333] mt-0.5 ${MONO}`}>
          <span>Any</span><span>Fair</span><span>Good</span><span>Strong</span><span>Best</span>
        </div>
      </SidebarSection>

      <SidebarSection label="Claims per episode">
        <div className="flex items-center gap-2 mb-1">
          <input
            type="range" min={1} max={10} step={1}
            value={filters.chunksPerEpisode}
            onChange={e => set({ chunksPerEpisode: parseInt(e.target.value) })}
            className="flex-1 h-1 rounded-full appearance-none cursor-pointer bg-[#1e1e1e] accent-[#C8900A]"
          />
          <span className={`text-[10px] text-[#C8900A] w-6 text-right shrink-0 ${MONO}`}>
            {filters.chunksPerEpisode}
          </span>
        </div>
      </SidebarSection>

      <SidebarSection label="Date range" defaultOpen={true}>
        {buckets.length > 0 ? (
          <HistogramSlider
            buckets={buckets}
            value={filters.dateRange[0] === -1 ? [0, buckets.length - 1] : filters.dateRange}
            onChange={r => {
              const isAll = r[0] === 0 && r[1] === buckets.length - 1;
              set({ dateRange: isAll ? [-1, -1] : r });
            }}
          />
        ) : (
          <div className={`text-[10px] text-[#666] ${MONO}`}>No episodes yet</div>
        )}
      </SidebarSection>

      {sources.length > 0 && (
        <SidebarSection label="Podcasts" defaultOpen={false}>
          <div className="space-y-1">
            {sources.map(s => {
              const active = filters.sourceIds.length === 0 || filters.sourceIds.includes(s.name);
              return (
                <button
                  key={s.id}
                  onClick={() => toggleSource(s.name)}
                  className="w-full flex items-center gap-2 py-0.5 text-left"
                >
                  <span className={`w-3 h-3 rounded border shrink-0 flex items-center justify-center transition-colors ${
                    active ? 'border-[#C8900A] bg-[#C8900A]' : 'border-[#2a2a2a] bg-transparent'
                  }`}>
                    {active && <span className="text-black text-[7px] font-bold leading-none">✓</span>}
                  </span>
                  <span className="text-[11px] text-[#999] truncate hover:text-[#888]">{s.name}</span>
                </button>
              );
            })}
          </div>
        </SidebarSection>
      )}

      {/* Apply button */}
      <div className="mt-auto pt-4">
        <button
          onClick={onApply}
          className={`w-full py-2 rounded border border-[#C8900A]/60 text-[#C8900A] hover:bg-[#C8900A] hover:text-black font-bold text-[10px] uppercase tracking-widest transition-colors ${MONO}`}
        >
          Apply filters
        </button>
      </div>

      {/* Nav links */}
      <div className="pt-3 border-t border-[#181818] space-y-1">
        {[
          { href: '/channels', label: 'Channels' },
          { href: '/episodes', label: 'Episodes' },
        ].map(({ href, label }) => (
          <a
            key={href}
            href={href}
            className={`block text-[10px] text-[#555] hover:text-[#aaa] py-1 transition-colors ${MONO} uppercase tracking-widest`}
          >
            {label}
          </a>
        ))}
      </div>
    </aside>
    </>
  );
}

// ─── Match Card ───────────────────────────────────────────────────────────────

function MatchCard({ match, showContext, quality, sameChunkAsPrev }: {
  match: Match; showContext: boolean; quality?: string | null; sameChunkAsPrev?: boolean;
}) {
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const speaker = match.chunk.speakerName ?? (match.chunk.speakerLabel !== null ? `Speaker ${match.chunk.speakerLabel}` : null);
  const SPEAKER = speaker?.toUpperCase() ?? null;
  const ytUrl = `https://youtu.be/${match.episode.externalId}?t=${Math.floor(match.chunk.startTimeSeconds)}`;

  async function handleSummary() {
    if (summaryLoading) return;
    if (summary) { setSummaryOpen(o => !o); return; }
    setSummaryLoading(true);
    setSummaryOpen(true);
    try {
      const res = await fetch(`/api/chunks/${match.chunk.id}/summary`, { method: 'POST' });
      if (!res.ok) { setSummary('Summary unavailable.'); return; }
      const data = await res.json();
      setSummary(data.summary || 'No summary generated.');
    } catch {
      setSummary('Summary unavailable.');
    } finally {
      setSummaryLoading(false);
    }
  }

  const pct = match.score * 100;
  const isIdea = ['thesis', 'competitive', 'position'].includes(match.claim.claimType);
  const borderColor = isIdea
    ? (pct >= 60 ? 'rgba(200,144,10,0.4)' : 'rgba(200,144,10,0.15)')
    : (pct >= 80 ? '#C8900A' : pct >= 60 ? 'rgba(200,144,10,0.6)' : pct >= 40 ? 'rgba(200,144,10,0.3)' : '#2a2a2a');
  const btn = `text-[11px] text-[#aaa] hover:text-white w-6 h-6 flex items-center justify-center rounded hover:bg-[#1e1e1e] transition-colors ${MONO}`;

  return (
    <>
      {sameChunkAsPrev && (
        <div className={`flex items-center gap-1.5 px-4 py-0.5 text-[8px] text-[#C8900A]/30 ${MONO}`}>
          <span>↳</span><span className="uppercase tracking-wider">same segment</span>
        </div>
      )}
      <div className={`relative border-b border-[#181818] pl-4 py-3 hover:bg-[#111] transition-colors group`}>
        {/* Left border — conviction-mapped amber */}
        <div className="absolute left-0 top-0 w-0.5 rounded-b-sm" style={{ height: '55%', background: borderColor }} />

        {/* Header: SOURCE / episode title  · claimType  date  ↗ */}
        <div className={`flex items-center mb-2 text-[10px] ${MONO}`}>
          <span className="text-[#bbb] uppercase tracking-wider shrink-0 font-semibold text-[9px]">
            {match.episode.source?.name ?? 'Unknown'}
          </span>
          <span className="text-[#2a2a2a] mx-1.5 shrink-0">/</span>
          <span className="text-[#777] truncate flex-1 min-w-0">{match.episode.title}</span>
          {match.episode.publishedAt && (
            <span className="text-[#444] ml-2 shrink-0 text-[9px]">{fmtDate(match.episode.publishedAt)}</span>
          )}
          <a href={ytUrl} target="_blank" rel="noopener noreferrer"
            className="text-[#555] hover:text-white ml-2 shrink-0 transition-colors" title="Open in YouTube">↗</a>
        </div>

        {/* Key quote — with optional inline context sentences */}
        <div className={`text-[14px] leading-[1.75] mb-1.5 ${MONO}`}>
          {SPEAKER && (
            <span className="mr-1.5 inline-flex items-center gap-1">
              <span className="text-[#C8900A] font-bold text-[11px] tracking-wide">{SPEAKER}</span>
              <span className="text-[#C8900A] font-bold text-[11px]">:</span>
            </span>
          )}
          {showContext ? (() => {
            const { before, after } = extractContext(match.chunk.text, match.claim.highlight);
            return (
              <>
                {before && <span className="text-[#666]">…{before} </span>}
                <span className="text-white font-medium">
                  "<HighlightText text={match.claim.highlight} phrase={match.claim.primarySubject} />"
                </span>
                {after && <span className="text-[#666]"> {after}…</span>}
              </>
            );
          })() : (
            <span className="text-white font-medium">
              "<HighlightText text={match.claim.highlight} phrase={match.claim.primarySubject} />"
            </span>
          )}
        </div>

        {/* AI Summary panel */}
        {(summaryLoading || summary) && summaryOpen && (
          <div className={`text-[12px] text-[#999] leading-[1.7] border-l-2 border-[#C8900A]/50 pl-3 mt-2 mb-2 ${MONO}`}>
            {summaryLoading ? <span className="text-[#555]">Generating…</span> : summary}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-1 mt-2">
          <a href={ytUrl} target="_blank" rel="noopener noreferrer"
            className={`flex items-center gap-1 bg-[#161616] border border-[#222] hover:border-[#333] rounded px-2 py-0.5 text-[10px] text-[#aaa] hover:text-white transition-colors ${MONO}`}>
            ▶ {fmt(match.chunk.startTimeSeconds)}
          </a>
          <div className="flex-1" />
          <button onClick={() => setTranscriptOpen(true)} className={btn} title="Full transcript">≡</button>
          <button
            onClick={handleSummary}
            disabled={summaryLoading}
            className={`${btn} ${summary && summaryOpen ? 'text-[#C8900A] hover:text-white' : ''} disabled:opacity-30`}
            title={summary ? (summaryOpen ? 'Collapse summary' : 'Expand summary') : 'AI summary'}
          >✦</button>
        </div>
      </div>

      {transcriptOpen && (
        <TranscriptModal
          episode={match.episode}
          highlightChunkId={match.chunk.id}
          onClose={() => setTranscriptOpen(false)}
        />
      )}
    </>
  );
}


// ─── Feed views ───────────────────────────────────────────────────────────────

function applyFilters(matches: Match[], filters: Filters, buckets: MonthBucket[]): Match[] {
  const episodeCounts: Record<string, number> = {};

  return matches.filter(m => {
    // ── Quality slider value ───────────────────────────────────────────────
    const r = filters.minRelevance ?? 0;

    // ── Score gate — slider directly gates by InterestMatch score ─────────
    if (r > 0 && m.score < r) return false;

    // ── Quality gate — drop only the lowest quality claims ────────────────
    if (m.quality === 'low') return false;

    // ── Following only — restrict to RSS-monitored sources ────────────────
    if (filters.followedOnly && !m.sourceFollowed) return false;

    // ── Minimum length — too short to be useful to an investor ────────────
    const wordCount = m.claim.highlight.trim().split(/\s+/).length;
    if (wordCount < 20) return false;

    // ── Quality slider — secondary filter ─────────────────────────────────
    if (r >= 0.75) {
      if (!m.claim.numbers || m.claim.numbers.length === 0) return false;
    } else if (r >= 0.55) {
      if (m.claim.specificity < 0.35) return false;
    }
    // Source filter
    if (filters.sourceIds.length > 0 && m.episode.source && !filters.sourceIds.includes(m.episode.source.name)) return false;
    // Date range
    if (filters.dateRange[0] !== -1 && buckets.length > 0) {
      const from = buckets[filters.dateRange[0]]?.month;
      const to = buckets[filters.dateRange[1]]?.month;
      const pub = m.episode.publishedAt?.slice(0, 7);
      if (from && pub && pub < from) return false;
      if (to && pub && pub > to) return false;
    }
    // Per-episode cap — matches are already sorted by score desc from the API
    const count = episodeCounts[m.episode.id] ?? 0;
    if (count >= filters.chunksPerEpisode) return false;
    episodeCounts[m.episode.id] = count + 1;
    return true;
  });
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className={`text-[9px] uppercase tracking-widest text-[#C8900A]/70 font-bold ${MONO}`}>
      {children}
    </span>
  );
}

function EmptyState() {
  return <div className={`text-[11px] text-[#2a2a2a] py-6 ${MONO}`}>No matches with current filters.</div>;
}

function QualityEmptyState({ lowCount, onShowLow }: { lowCount: number; onShowLow?: () => void }) {
  return (
    <div className={`py-4 ${MONO}`}>
      <p className="text-[11px] text-[#2a2a2a] mb-2 leading-relaxed">
        No complete investor claims found for this term in the selected sources.<br />
        Try expanding the date range or adding sources.
      </p>
      {lowCount > 0 && onShowLow && (
        <button
          onClick={onShowLow}
          className={`text-[9px] text-[#444] hover:text-[#666] transition-colors uppercase tracking-wider`}
        >
          Show {lowCount} lower-quality match{lowCount !== 1 ? 'es' : ''}
        </button>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 py-1">
      {[1, 2, 3].map(i => (
        <div key={i} className="animate-pulse border-b border-[#181818] pb-3">
          <div className="h-2 bg-[#1a1a1a] rounded w-2/3 mb-2" />
          <div className="h-2.5 bg-[#161616] rounded w-full mb-1" />
          <div className="h-2.5 bg-[#161616] rounded w-4/5" />
        </div>
      ))}
    </div>
  );
}

// ─── Interest Digest Banner ───────────────────────────────────────────────────

function InterestDigest({ interestId }: { interestId: string }) {
  const [digest, setDigest] = useState<DigestData | null>(null);

  useEffect(() => {
    fetch(`/api/interests/${interestId}/digest`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && !d.error) setDigest(d); })
      .catch(() => {});
  }, [interestId]);

  if (!digest || (digest.weekCount === 0 && digest.todayCount === 0)) return null;

  return (
    <div className={`mb-3 pb-3 border-b border-[#141414] ${MONO}`}>
      <div className="flex items-center gap-2 flex-wrap">
        {digest.todayCount > 0 && (
          <span className="text-[10px] text-[#C8900A]">
            {digest.todayCount} show{digest.todayCount !== 1 ? 's' : ''} published today
          </span>
        )}
        {digest.todayCount > 0 && digest.weekCount > digest.todayCount && (
          <span className="text-[#2a2a2a]">·</span>
        )}
        {digest.weekCount > 0 && (
          <span className="text-[10px] text-[#555]">
            {digest.weekCount} active this week
          </span>
        )}
        {digest.weekCount === 0 && digest.todayCount === 0 && (
          <span className="text-[10px] text-[#333]">no recent coverage</span>
        )}
        <span className="text-[10px] text-[#2a2a2a]">· podcast index</span>
      </div>
    </div>
  );
}

function ByInterestView({ interests, matchesByInterest, filters, buckets, onReindex }: {
  interests: Interest[];
  matchesByInterest: Record<string, Match[]>;
  filters: Filters;
  buckets: MonthBucket[];
  onReindex: (id: string) => void;
}) {
  return (
    <div>
      {interests.map(interest => {
        const loaded = interest.id in matchesByInterest;
        const all = matchesByInterest[interest.id] ?? [];
        const filtered = applyFilters(all, filters, buckets);

        return (
          <div key={interest.id} className="mb-8">
            <div className="flex items-center justify-between mb-3 mt-1">
              <SectionLabel>
                {interest.term}
                {loaded
                  ? <span className="text-[#666] font-normal ml-1">{filtered.length}</span>
                  : <span className={`text-[#444] font-normal ml-2 ${MONO}`}>loading…</span>
                }
              </SectionLabel>
              <button
                onClick={() => onReindex(interest.id)}
                className={`text-[9px] text-[#444] hover:text-[#C8900A] border border-[#1e1e1e] hover:border-[#C8900A]/40 px-2 py-0.5 rounded transition-colors ${MONO} uppercase tracking-wider`}
                title="Delete stored matches and re-run with current engine settings"
              >
                Re-scan
              </button>
            </div>

            {loaded && <InterestDigest interestId={interest.id} />}

            {!loaded ? (
              <LoadingSkeleton />
            ) : filtered.length === 0 ? (
              <EmptyState />
            ) : (
              filtered.map((m, i) => (
                <MatchCard
                  key={m.id} match={m} showContext={filters.showContext} quality={m.quality}
                  sameChunkAsPrev={i > 0 && m.chunk.id === filtered[i - 1].chunk.id}
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

function ByPodcastView({ allMatches, filters, buckets }: { allMatches: Match[]; filters: Filters; buckets: MonthBucket[] }) {
  const filtered = applyFilters(allMatches, filters, buckets);
  const bySource: Record<string, Match[]> = {};
  for (const m of filtered) {
    const key = m.episode.source?.name ?? 'Unknown';
    (bySource[key] ??= []).push(m);
  }
  return (
    <div>
      {Object.entries(bySource).sort(([a], [b]) => a.localeCompare(b)).map(([source, matches]) => (
        <div key={source} className="mb-8">
          <SectionLabel>{source} <span className="text-[#666] font-normal ml-1">{matches.length}</span></SectionLabel>
          {matches.map((m, i) => (
            <MatchCard key={m.id} match={m} showContext={filters.showContext} quality={m.quality}
              sameChunkAsPrev={i > 0 && m.chunk.id === matches[i - 1].chunk.id} />
          ))}
        </div>
      ))}
      {Object.keys(bySource).length === 0 && <EmptyState />}
    </div>
  );
}

function CombinedView({ allMatches, filters, buckets }: { allMatches: Match[]; filters: Filters; buckets: MonthBucket[] }) {
  const sorted = applyFilters(allMatches, filters, buckets)
    .slice()
    .sort((a, b) => (b.episode.publishedAt ?? b.createdAt).localeCompare(a.episode.publishedAt ?? a.createdAt));
  return (
    <div>
      {sorted.length === 0 ? <EmptyState /> : sorted.map((m, i) => (
        <MatchCard key={m.id} match={m} showContext={filters.showContext} quality={m.quality}
          sameChunkAsPrev={i > 0 && m.chunk.id === sorted[i - 1].chunk.id} />
      ))}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export function InterestFeed() {
  const [interests, setInterests] = useState<Interest[]>([]);
  const [matchesByInterest, setMatchesByInterest] = useState<Record<string, Match[]>>({});
  const [sources, setSources] = useState<Source[]>([]);
  const [buckets, setBuckets] = useState<MonthBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTerm, setNewTerm] = useState('');
  const [adding, setAdding] = useState(false);
  const [backfillingId, setBackfillingId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('by_interest');
  const [filters, setFilters] = useState<Filters>({
    convictionMin: 0,
    noveltyMin: 0,
    minRelevance: 0,
    chunksPerEpisode: 4,
    dateRange: [-1, -1],
    sourceIds: [],
    showContext: true,
    followedOnly: false,
  });

  const loadInterests = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/interests');
    const data = await res.json();
    const list: Interest[] = data.interests ?? [];
    setInterests(list);
    // Clear stale match data so per-interest loading states appear correctly
    setMatchesByInterest({});
    await Promise.all(list.map(async interest => {
      const r = await fetch(`/api/feed/interests?interestId=${interest.id}&limit=100`);
      const d = r.ok ? await r.json().catch(() => ({})) : {};
      setMatchesByInterest(prev => ({ ...prev, [interest.id]: d.matches ?? [] }));
    }));
    setLoading(false);
  }, []);

  useEffect(() => { loadInterests(); }, [loadInterests]);

  useEffect(() => {
    fetch('/api/channels')
      .then(r => r.json())
      .then(d => setSources((d.channels ?? d.sources ?? []).map((s: any) => ({ id: s.id, name: s.name }))));
    fetch('/api/episodes/distribution')
      .then(r => r.json())
      .then(d => setBuckets(d.months ?? []));
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newTerm.trim()) return;
    setAdding(true);
    try {
      const res = await fetch('/api/interests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term: newTerm.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewTerm('');
        await loadInterests();
        // Backfill is async — poll until matches appear (max 30s)
        if (data.interest?.id) setBackfillingId(data.interest.id);
      }
    } finally { setAdding(false); }
  }

  // Poll the new interest until its backfill produces results
  useEffect(() => {
    if (!backfillingId) return;
    let attempts = 0;
    const id = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch(`/api/feed/interests?interestId=${backfillingId}&limit=1`);
        const d = await r.json();
        if (d.total > 0 || attempts >= 15) {
          clearInterval(id);
          setBackfillingId(null);
          if (d.total > 0) await loadInterests();
        }
      } catch {
        clearInterval(id);
        setBackfillingId(null);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [backfillingId, loadInterests]);

  async function handleDeleteInterest(id: string) {
    await fetch(`/api/interests/${id}`, { method: 'DELETE' });
    setInterests(prev => prev.filter(i => i.id !== id));
    setMatchesByInterest(prev => { const n = { ...prev }; delete n[id]; return n; });
  }

  async function handleReindex(interestId: string) {
    setMatchesByInterest(prev => { const n = { ...prev }; delete n[interestId]; return n; });
    try {
      const res = await fetch(`/api/interests/${interestId}/reindex`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('[Reindex error]', err);
      }
    } catch (err) {
      // Hot reload or network abort — swallow, still reload matches below
      console.error('[Reindex fetch aborted]', err);
    }
    // Reload matches regardless of whether reindex succeeded (may show stale data)
    try {
      const r = await fetch(`/api/feed/interests?interestId=${interestId}&limit=100`);
      const d = r.ok ? await r.json().catch(() => ({})) : {};
      setMatchesByInterest(prev => ({ ...prev, [interestId]: d.matches ?? [] }));
    } catch {
      // Network error during reload — leave matches empty
    }
  }

  const allMatches = Object.values(matchesByInterest).flat();

  return (
    <div className="flex h-screen bg-[#0a0a0a] overflow-hidden">
      <Sidebar
        filters={filters}
        setFilters={setFilters}
        viewMode={viewMode}
        setViewMode={setViewMode}
        sources={sources}
        buckets={buckets}
        onApply={loadInterests}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Search bar */}
        <div className={`border-b border-[#141414] px-5 py-3 flex items-center gap-2 shrink-0`}>
          <button
            onClick={() => setSidebarOpen(true)}
            className={`md:hidden text-[#555] hover:text-[#aaa] w-7 h-7 flex items-center justify-center shrink-0 rounded hover:bg-[#1a1a1a] transition-colors`}
            aria-label="Open filters"
          >⚙</button>
          <div className="flex flex-wrap gap-1.5 flex-1 min-w-0 items-center">
            {interests.map(i => (
              <span key={i.id} className={`flex items-center gap-1 bg-[#141414] border border-[#1e1e1e] text-[#888] text-[11px] px-2 py-0.5 rounded ${MONO}`}>
                {i.term}
                <button
                  type="button"
                  onClick={() => handleDeleteInterest(i.id)}
                  className="text-[#666] hover:text-[#888] ml-0.5"
                >×</button>
              </span>
            ))}
            <input
              value={newTerm}
              onChange={e => setNewTerm(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd(e as any)}
              placeholder={interests.length === 0 ? 'e.g. NVDA, Elon Musk, AI infrastructure…' : 'Add term…'}
              className={`bg-transparent text-[13px] text-white focus:outline-none min-w-40 ${MONO} placeholder-[#2e2e2e]`}
            />
          </div>
          {backfillingId && (
            <span className={`text-[10px] text-[#555] ${MONO} animate-pulse shrink-0`}>searching…</span>
          )}
          <button
            onClick={handleAdd}
            disabled={adding || !newTerm.trim()}
            className={`text-[10px] text-[#C8900A] hover:text-black hover:bg-[#C8900A] disabled:opacity-30 border border-[#C8900A]/40 hover:border-[#C8900A] px-3 py-1.5 rounded transition-colors ${MONO} shrink-0`}
          >
            {adding ? '…' : '+ Monitor'}
          </button>
        </div>

        {/* Feed */}
        <div className="flex-1 overflow-y-auto px-5">
          {loading && interests.length === 0 && (
            <div className={`text-[11px] text-[#444] pt-20 text-center ${MONO} animate-pulse`}>
              Loading…
            </div>
          )}
          {!loading && interests.length === 0 && (
            <div className={`text-[11px] text-[#2a2a2a] pt-20 text-center ${MONO}`}>
              Add a monitoring term above.
            </div>
          )}

          {viewMode === 'by_interest' && (
            <ByInterestView
              interests={interests}
              matchesByInterest={matchesByInterest}
              filters={filters}
              buckets={buckets}
              onReindex={handleReindex}
            />
          )}
          {viewMode === 'by_podcast' && (
            loading
              ? <LoadingSkeleton />
              : <ByPodcastView allMatches={allMatches} filters={filters} buckets={buckets} />
          )}
          {viewMode === 'combined' && (
            loading
              ? <LoadingSkeleton />
              : <CombinedView allMatches={allMatches} filters={filters} buckets={buckets} />
          )}
        </div>
      </main>
    </div>
  );
}
