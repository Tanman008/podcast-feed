'use client';

import { useState } from 'react';

interface Entity {
  id: string;
  name: string;
  ticker: string | null;
  entityType: string;
  confidence: number;
}

interface FeedChunkProps {
  id: string;
  text: string;
  keyQuote: string | null;
  keyPhrase: string | null;
  startTimeSeconds: number;
  endTimeSeconds: number;
  speakerLabel: string | null;
  speakerName: string | null;
  noveltyScore: number | null;
  convictionScore: number | null;
  entities: Entity[];
  episode?: {
    id: string;
    externalId: string;
    title: string;
    publishedAt: string | null;
    source?: { name: string; platform: string } | null;
  } | null;
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? [text])
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

function pickFallbackSentence(text: string): string | null {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return null;
  const scored = sentences.map(s => ({
    s,
    score: (s.match(/[\d$%]|billion|million|trillion/gi) ?? []).length * 10 + s.length,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].s;
}

function extractContext(text: string, keyQuote: string): { before: string | null; after: string | null } {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return { before: null, after: null };
  const needle = keyQuote.toLowerCase().slice(0, 40).trim();
  let idx = sentences.findIndex(s => s.toLowerCase().includes(needle));
  if (idx === -1) {
    const needle2 = keyQuote.toLowerCase().slice(0, 20).trim();
    idx = sentences.findIndex(s => s.toLowerCase().includes(needle2));
  }
  if (idx === -1) return { before: null, after: null };
  return {
    before: idx > 0 ? sentences[idx - 1] : null,
    after: idx < sentences.length - 1 ? sentences[idx + 1] : null,
  };
}

function KeyQuoteText({ keyQuote, keyPhrase }: { keyQuote: string; keyPhrase: string | null }) {
  const lq = keyQuote.toLowerCase();
  const lp = keyPhrase?.toLowerCase() ?? '';
  const idx = lp ? lq.indexOf(lp) : -1;
  if (idx === -1) return <span>{keyQuote}</span>;
  return (
    <span>
      {keyQuote.slice(0, idx)}
      <span className="underline decoration-amber-500/60 decoration-2 underline-offset-2">
        {keyQuote.slice(idx, idx + keyPhrase!.length)}
      </span>
      {keyQuote.slice(idx + keyPhrase!.length)}
    </span>
  );
}

function fmt(s: number): string {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function convictionBorder(score: number | null): string {
  if (score === null) return '#e5e7eb'; // gray-200
  if (score >= 0.7) return '#22c55e';  // green
  if (score >= 0.4) return '#f59e0b';  // amber
  return '#d1d5db';                    // gray-300
}

function ScoreBadge({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const color =
    value >= 0.7 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
    value >= 0.4 ? 'bg-amber-50  text-amber-700  border-amber-200'  :
                   'bg-gray-50   text-gray-500   border-gray-200';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${color}`}>
      {label} {pct}%
    </span>
  );
}

export function FeedCard({ chunk }: { chunk: FeedChunkProps }) {
  const [showContext, setShowContext] = useState(true);

  const publishDate = chunk.episode?.publishedAt
    ? new Date(chunk.episode.publishedAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : null;

  const videoId = chunk.episode?.externalId ?? null;
  const timestampUrl = videoId
    ? `https://youtu.be/${videoId}?t=${Math.floor(chunk.startTimeSeconds)}`
    : null;

  const topEntities = chunk.entities.filter(e => e.confidence >= 0.7).slice(0, 6);

  const effectiveQuote = chunk.keyQuote ?? pickFallbackSentence(chunk.text);
  const { before, after } = effectiveQuote
    ? extractContext(chunk.text, effectiveQuote)
    : { before: null, after: null };

  const speakerDisplay = chunk.speakerName ?? (chunk.speakerLabel ? `Speaker ${chunk.speakerLabel}` : null);

  return (
    <div
      className="bg-white border border-gray-100 border-l-[3px] rounded-xl p-4 mb-2.5 hover:shadow-md hover:bg-gray-50/50 transition-all"
      style={{ borderLeftColor: convictionBorder(chunk.convictionScore) }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="min-w-0">
          <div className="text-[10px] text-gray-400 uppercase tracking-widest font-semibold mb-0.5">
            {chunk.episode?.source?.name ?? 'Unknown source'}
          </div>
          <h3 className="text-sm font-semibold text-gray-900 leading-snug">
            {chunk.episode?.title ?? 'Untitled'}
          </h3>
          {publishDate && (
            <div className="text-[11px] text-gray-400 mt-0.5">{publishDate}</div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
          <ScoreBadge label="C" value={chunk.convictionScore} />
          <ScoreBadge label="N" value={chunk.noveltyScore} />
        </div>
      </div>

      {/* Quote block */}
      {effectiveQuote ? (
        <div className="text-sm leading-[1.75] text-gray-700 mb-2.5">
          {showContext && before && (
            <>
              <p className="text-gray-400 italic mb-1.5">{before}</p>
              <div className="border-t border-gray-100 mb-1.5" />
            </>
          )}
          <p className="font-semibold text-gray-900">
            <KeyQuoteText keyQuote={effectiveQuote} keyPhrase={chunk.keyQuote ? chunk.keyPhrase : null} />
          </p>
          {showContext && after && (
            <>
              <div className="border-t border-gray-100 mt-1.5 mb-1.5" />
              <p className="text-gray-400 italic">{after}</p>
            </>
          )}
        </div>
      ) : (
        <p className="text-sm leading-[1.75] text-gray-700 mb-2.5 line-clamp-3">{chunk.text}</p>
      )}

      {/* Entity chips */}
      {topEntities.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2.5">
          {topEntities.map(entity => (
            <span
              key={entity.id}
              className="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full border border-gray-200"
            >
              {entity.ticker ?? entity.name}
            </span>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 flex-wrap">
        {timestampUrl ? (
          <a
            href={timestampUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 bg-gray-100 hover:bg-gray-200 border border-gray-200 text-gray-500 hover:text-gray-700 text-[11px] px-2 py-0.5 rounded transition-colors font-mono"
          >
            ▶ {fmt(chunk.startTimeSeconds)} – {fmt(chunk.endTimeSeconds)}
          </a>
        ) : (
          <span className="text-[11px] bg-gray-100 border border-gray-200 text-gray-400 px-2 py-0.5 rounded font-mono">
            {fmt(chunk.startTimeSeconds)} – {fmt(chunk.endTimeSeconds)}
          </span>
        )}

        {speakerDisplay && (
          <span className="text-[11px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded">
            {speakerDisplay}
          </span>
        )}

        {(before || after) && (
          <button
            onClick={() => setShowContext(v => !v)}
            className="text-[11px] text-gray-400 hover:text-gray-600 px-2 py-0.5 rounded hover:bg-gray-100 transition-colors ml-auto"
          >
            {showContext ? 'Hide context' : 'Show context'}
          </button>
        )}
      </div>
    </div>
  );
}
