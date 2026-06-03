'use client';

import { useState, useEffect } from 'react';

type Mode = 'url' | 'search';

export function IngestionForm({ onSuccess }: { onSuccess?: () => void } = {}) {
  const [mode, setMode] = useState<Mode>('url');

  // ── URL mode state ──────────────────────────────────────────────────────────
  const [episodeUrl, setEpisodeUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'queued' | 'running' | 'completed' | 'failed' | null>(null);
  const [podcastName, setPodcastName] = useState<string | null>(null);
  const [episodeTitle, setEpisodeTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Search mode state ───────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [sinceMonths, setSinceMonths] = useState<number | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<{
    sourceName: string; queued: number; expansion: { queries: string[] };
  } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId || !['queued', 'running'].includes(status || '')) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/ingest/jobs/${jobId}`);
        if (!res.ok) throw new Error('Failed to fetch job status');
        const data = await res.json();
        setProgress(data.progress);
        setStatus(data.status);
        if (data.status === 'failed') setError(data.errorMessage);
        if (data.status === 'completed') {
          setTimeout(() => {
            setJobId(null);
            setProgress(0);
            setEpisodeUrl('');
            setPodcastName(null);
            setEpisodeTitle(null);
            setError(null);
            setStatus(null);
          }, 2000);
        }
      } catch (err: any) {
        setError(err.message);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [jobId, status]);

  async function handleUrlSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/ingest/podcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to enqueue job');
      setJobId(data.jobId);
      setStatus('queued');
      setProgress(0);
      setPodcastName(data.podcastName ?? null);
      setEpisodeTitle(data.episodeTitle ?? null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSearchError(null);
    setSearchResult(null);
    setSearchLoading(true);
    try {
      const res = await fetch('/api/ingest/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery.trim(), sinceMonths }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setSearchResult(data);
      setSearchQuery('');
      onSuccess?.();
    } catch (err: any) {
      setSearchError(err.message);
    } finally {
      setSearchLoading(false);
    }
  }

  const tabClass = (m: Mode) =>
    `flex-1 py-1.5 text-center text-[10px] uppercase tracking-wider transition-colors font-bold ${
      mode === m
        ? 'bg-[#C8900A] text-black'
        : 'text-[#555] hover:text-[#aaa] hover:bg-[#111]'
    }`;

  if (jobId) {
    return (
      <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-5 space-y-3">
        <h3 className="text-xs font-semibold text-[#888] uppercase tracking-widest">Ingesting…</h3>
        {episodeTitle && <p className="text-xs text-[#ccc] truncate">{episodeTitle}</p>}
        {podcastName && <p className="text-[11px] text-[#555]">{podcastName}</p>}
        <div>
          <div className="flex justify-between text-[10px] text-[#555] mb-1">
            <span>{status === 'running' ? 'Processing' : 'Queued'}</span>
            <span>{progress}%</span>
          </div>
          <div className="bg-[#1a1a1a] rounded-full h-1">
            <div
              className="bg-[#C8900A] h-1 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        {status === 'completed' && <p className="text-[11px] text-emerald-400 font-medium">✓ Done</p>}
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-5 space-y-3">
      <h3 className="text-xs font-semibold text-[#888] uppercase tracking-widest">Ingest</h3>

      {/* Mode tabs */}
      <div className="flex rounded border border-[#232323] overflow-hidden">
        <button type="button" onClick={() => setMode('url')} className={tabClass('url')}>URL</button>
        <button type="button" onClick={() => setMode('search')} className={tabClass('search')}>Search</button>
      </div>

      {mode === 'url' ? (
        <form onSubmit={handleUrlSubmit} className="space-y-3">
          <p className="text-[11px] text-[#444]">
            Paste a Podcast Index episode URL or RSS feed URL. Podcast is detected automatically.
          </p>
          <input
            type="url"
            placeholder="https://podcastindex.org/podcast/920666/episode/..."
            value={episodeUrl}
            onChange={e => setEpisodeUrl(e.target.value)}
            required
            className="w-full px-3 py-2 bg-[#080808] border border-[#222] rounded-lg text-sm text-white placeholder-[#333] focus:outline-none focus:ring-1 focus:ring-[#C8900A]/40"
          />
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-2 bg-[#C8900A] text-black rounded-lg text-xs font-bold hover:bg-[#a97208] disabled:opacity-50 transition-colors uppercase tracking-widest"
          >
            {loading ? 'Checking…' : 'Ingest'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleSearchSubmit} className="space-y-3">
          <p className="text-[11px] text-[#444]">
            Search by company, person, or theme. Episodes are ingested and re-checked periodically for new matches.
          </p>
          <input
            type="text"
            placeholder="e.g. NVDA, Jensen Huang, AI infrastructure…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            required
            className="w-full px-3 py-2 bg-[#080808] border border-[#222] rounded-lg text-sm text-white placeholder-[#333] focus:outline-none focus:ring-1 focus:ring-[#C8900A]/40"
          />
          <div>
            <div className="text-[9px] text-[#444] uppercase tracking-widest mb-1.5">Episodes from</div>
            <div className="flex flex-wrap gap-1">
              {([
                [null,  'All time'],
                [6,     '6 mo'],
                [12,    '1 yr'],
                [24,    '2 yr'],
                [60,    '5 yr'],
              ] as [number | null, string][]).map(([months, label]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setSinceMonths(months)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                    sinceMonths === months
                      ? 'bg-[#C8900A] border-[#C8900A] text-black font-bold'
                      : 'border-[#232323] bg-[#111] text-[#555] hover:border-[#C8900A]/50 hover:text-[#C8900A]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {searchError && <p className="text-[11px] text-red-400">{searchError}</p>}
          {searchResult && (
            <div className="text-[11px] text-emerald-400 space-y-0.5">
              <p>✓ Subscribed to <span className="font-semibold">{searchResult.sourceName}</span> — {searchResult.queued} episode{searchResult.queued !== 1 ? 's' : ''} queued</p>
              {searchResult.expansion?.queries?.length > 0 && (
                <p className="text-[#555]">Queries: {searchResult.expansion.queries.join(' · ')}</p>
              )}
            </div>
          )}
          <button
            type="submit"
            disabled={searchLoading || !searchQuery.trim()}
            className="w-full px-4 py-2 bg-[#C8900A] text-black rounded-lg text-xs font-bold hover:bg-[#a97208] disabled:opacity-50 transition-colors uppercase tracking-widest"
          >
            {searchLoading ? 'Searching…' : 'Search & Subscribe'}
          </button>
        </form>
      )}
    </div>
  );
}
