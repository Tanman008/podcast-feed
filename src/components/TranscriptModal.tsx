'use client';

import { useEffect, useState, useRef } from 'react';

interface TranscriptChunk {
  id: string;
  chunkIndex: number;
  text: string;
  startTimeSeconds: number;
  speakerName: string | null;
  speakerLabel: string | null;
}

interface TranscriptEpisode {
  id: string;
  title: string;
  source: { name: string } | null;
  externalId: string;
}

interface Paragraph {
  speaker: string;
  startTimeSeconds: number;
  chunkIds: string[]; // all merged chunk IDs — highlight matches any of these
  text: string;
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function buildParagraphs(chunks: TranscriptChunk[]): Paragraph[] {
  const paras: Paragraph[] = [];
  for (const chunk of chunks) {
    const knownSpeaker = chunk.speakerName ?? (chunk.speakerLabel ? `Speaker ${chunk.speakerLabel}` : null);
    const last = paras[paras.length - 1];
    // Only merge when both chunks share the same *known* speaker label.
    // Unknown-speaker chunks each get their own paragraph so the highlight ref
    // can target a specific position rather than collapsing the whole transcript.
    if (knownSpeaker && last && last.speaker === knownSpeaker) {
      last.text += ' ' + chunk.text;
      last.chunkIds.push(chunk.id);
    } else {
      paras.push({
        speaker: knownSpeaker ?? `[${chunk.chunkIndex + 1}]`,
        startTimeSeconds: chunk.startTimeSeconds,
        chunkIds: [chunk.id],
        text: chunk.text,
      });
    }
  }
  return paras;
}

// Rotating speaker colors (Bloomberg-ish palette)
const SPEAKER_COLORS = ['#C8900A', '#4d9fff', '#ff9500', '#ff6b6b', '#bd93f9', '#50fa7b'];
function speakerColor(name: string, all: string[]): string {
  const idx = all.indexOf(name);
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length] ?? '#888';
}

export function TranscriptModal({
  episode,
  onClose,
  highlightChunkId,
}: {
  episode: TranscriptEpisode;
  onClose: () => void;
  highlightChunkId?: string;
}) {
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const highlightRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/transcript/${episode.id}`)
      .then(r => r.json())
      .then(data => { setChunks(data.chunks ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [episode.id]);

  // Scroll to highlighted paragraph after DOM settles.
  // Uses rAF + fallback timeout to handle fixed-position overlay quirks.
  useEffect(() => {
    if (loading || !highlightRef.current || !scrollContainerRef.current) return;
    const container = scrollContainerRef.current;
    const target = highlightRef.current;
    requestAnimationFrame(() => {
      const containerTop = container.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      const offset = targetTop - containerTop + container.scrollTop;
      container.scrollTo({ top: offset - container.clientHeight / 2 + target.clientHeight / 2, behavior: 'smooth' });
    });
  }, [loading]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const paragraphs = buildParagraphs(chunks);
  const allSpeakers = [...new Set(paragraphs.map(p => p.speaker))];

  return (
    <div ref={scrollContainerRef} className="fixed inset-0 z-50 flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-3xl bg-[#111] border border-[#222] rounded-xl mt-8 mb-16">
        {/* Header */}
        <div className="sticky top-0 bg-[#111] border-b border-[#1e1e1e] px-6 py-4 flex items-start justify-between rounded-t-xl z-10">
          <div>
            <div className="text-xs text-[#555] uppercase tracking-wider mb-1">{episode.source?.name}</div>
            <h2 className="text-sm font-semibold text-[#e8e8e8] leading-snug">{episode.title}</h2>
          </div>
          <button onClick={onClose} className="text-[#555] hover:text-[#e8e8e8] text-lg ml-4 shrink-0 mt-0.5">✕</button>
        </div>

        {/* Speaker legend */}
        {allSpeakers.length > 0 && (
          <div className="px-6 py-3 border-b border-[#1a1a1a] flex flex-wrap gap-3">
            {allSpeakers.map(s => (
              <span key={s} className="text-xs flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: speakerColor(s, allSpeakers) }} />
                <span style={{ color: speakerColor(s, allSpeakers) }}>{s}</span>
              </span>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="px-6 py-6 space-y-5">
          {loading && <p className="text-sm text-[#555]">Loading transcript…</p>}

          {!loading && paragraphs.map((para, i) => {
            const color = speakerColor(para.speaker, allSpeakers);
            const isHighlight = !!highlightChunkId && para.chunkIds.includes(highlightChunkId);
            return (
              <div
                key={i}
                ref={isHighlight ? highlightRef : undefined}
                className={`flex gap-4 transition-colors ${isHighlight ? 'bg-[#C8900A]/10 -mx-3 px-3 py-2 rounded border-l-2 border-[#C8900A]' : ''}`}
              >
                {/* Timestamp */}
                <a
                  href={`https://youtu.be/${episode.externalId}?t=${Math.floor(para.startTimeSeconds)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[#444] hover:text-[#888] font-mono shrink-0 pt-0.5 w-10 text-right"
                >
                  {fmt(para.startTimeSeconds)}
                </a>
                {/* Speaker bar */}
                <div className="w-0.5 shrink-0 rounded-full self-stretch" style={{ background: color }} />
                {/* Text */}
                <div className="min-w-0">
                  <div className="text-xs font-bold mb-1" style={{ color }}>{para.speaker}</div>
                  <p className="text-sm text-[#ccc] leading-relaxed">{para.text}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
