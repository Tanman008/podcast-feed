'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { IngestionForm } from '@/components/IngestionForm';

interface Channel {
  id: string;
  name: string;
  url: string;
  episodeCount: number;
  createdAt: string;
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  checkIntervalHours: number;
  lastCheckedAt: string | null;
  searchQuery: string | null;
}

interface JobSummary {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  total: number;
  active: boolean;
  overallProgress: number;
}

const MAX_MINS = 240;

function secsToMins(s: number | null): number | null {
  return s === null ? null : Math.round(s / 60);
}
function minsToSecs(m: number | null): number | null {
  return m === null ? null : m * 60;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const BACKFILL_OPTIONS = [
  { label: 'New only',      count: 0 },
  { label: '5 episodes',   count: 5 },
  { label: '10 episodes',  count: 10 },
  { label: '25 episodes',  count: 25 },
  { label: '50 episodes',  count: 50 },
  { label: '100 episodes', count: 100 },
];

const INTERVAL_OPTIONS = [
  { label: '30 min',   hours: 0.5 },
  { label: '1 hr',     hours: 1 },
  { label: '2 hrs',    hours: 2 },
  { label: '6 hrs',    hours: 6 },
  { label: '12 hrs',   hours: 12 },
  { label: '24 hrs',   hours: 24 },
];

function DurationField({
  label,
  valueMins,
  onChange,
  allowNull,
  nullLabel = 'No limit',
}: {
  label: string;
  valueMins: number | null;
  onChange: (mins: number | null) => void;
  allowNull?: boolean;
  nullLabel?: string;
}) {
  const isNull = valueMins === null;
  const sliderVal = isNull ? MAX_MINS : Math.min(valueMins, MAX_MINS);

  const handleSlider = (v: number) => {
    if (allowNull && v >= MAX_MINS) { onChange(null); return; }
    onChange(v);
  };

  const handleInput = (raw: string) => {
    const n = parseInt(raw);
    if (isNaN(n) || n < 0) return;
    onChange(Math.min(n, allowNull ? 99999 : MAX_MINS));
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="text-[10px] text-[#666] mb-1 uppercase tracking-widest">{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={MAX_MINS}
          step={1}
          value={sliderVal}
          onChange={e => handleSlider(parseInt(e.target.value))}
          disabled={allowNull && isNull}
          className="flex-1 accent-[#C8900A] disabled:opacity-40"
        />
        {isNull ? (
          <span className="text-[11px] text-[#555] w-20 text-right shrink-0">{nullLabel}</span>
        ) : (
          <div className="flex items-center gap-1 shrink-0">
            <input
              type="number"
              min={0}
              max={allowNull ? 9999 : MAX_MINS}
              step={1}
              value={valueMins ?? ''}
              onChange={e => handleInput(e.target.value)}
              className="w-14 px-1.5 py-0.5 bg-[#080808] border border-[#222] rounded text-[11px] text-center text-white focus:outline-none focus:ring-1 focus:ring-[#C8900A]/40"
            />
            <span className="text-[11px] text-[#555]">min</span>
          </div>
        )}
        {allowNull && (
          <label className="flex items-center gap-1 shrink-0 cursor-pointer">
            <input
              type="checkbox"
              checked={isNull}
              onChange={e => onChange(e.target.checked ? null : MAX_MINS)}
              className="accent-[#C8900A] w-3 h-3"
            />
            <span className="text-[11px] text-[#555]">{nullLabel}</span>
          </label>
        )}
      </div>
    </div>
  );
}

function ChannelSettings({ channel, onSaved }: { channel: Channel; onSaved: () => void }) {
  const [minMins, setMinMins] = useState<number | null>(secsToMins(channel.minDurationSeconds) ?? 2);
  const [maxMins, setMaxMins] = useState<number | null>(secsToMins(channel.maxDurationSeconds));
  const [intervalHours, setIntervalHours] = useState(channel.checkIntervalHours);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/channels/${channel.id}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minDurationSeconds: minsToSecs(minMins),
          maxDurationSeconds: minsToSecs(maxMins),
          checkIntervalHours: intervalHours,
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-[#1e1e1e] space-y-4">
      <div>
        <div className="text-[10px] text-[#666] uppercase tracking-widest mb-2">Episode length filter</div>
        <div className="flex gap-4 flex-wrap">
          <DurationField label="Minimum" valueMins={minMins} onChange={setMinMins} allowNull={false} />
          <DurationField label="Maximum" valueMins={maxMins} onChange={setMaxMins} allowNull nullLabel="No max" />
        </div>
        <div className="text-[10px] text-[#444] mt-1">
          Episodes outside this range are skipped.
        </div>
      </div>

      <div>
        <div className="text-[10px] text-[#666] uppercase tracking-widest mb-2">Auto-check frequency</div>
        <div className="flex flex-wrap gap-1.5">
          {INTERVAL_OPTIONS.map(opt => (
            <button
              key={opt.hours}
              onClick={() => setIntervalHours(opt.hours)}
              className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
                intervalHours === opt.hours
                  ? 'bg-[#C8900A] border-[#C8900A] text-black font-bold'
                  : 'border-[#232323] bg-[#111] text-[#666] hover:border-[#C8900A]/50 hover:text-[#C8900A]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-1.5 bg-[#C8900A] text-black rounded-lg text-xs font-bold hover:bg-[#a97208] disabled:opacity-50 transition-colors uppercase tracking-widest"
      >
        {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save settings'}
      </button>
    </div>
  );
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [url, setUrl] = useState('');
  const [backfillCount, setBackfillCount] = useState(0);
  const [addMinMins, setAddMinMins] = useState<number | null>(2);
  const [addMaxMins, setAddMaxMins] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [showAddOptions, setShowAddOptions] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<Record<string, JobSummary>>({});
  const [watchingIds, setWatchingIds] = useState<string[]>([]);
  const [watchingSince, setWatchingSince] = useState<Record<string, number>>({});

  async function load() {
    const res = await fetch('/api/channels');
    const data = await res.json();
    const chs: Channel[] = data.channels ?? [];
    setChannels(chs);
    // Check for active jobs on any channel (2h window — no since param = API default)
    await Promise.all(chs.map(async ch => {
      try {
        const r = await fetch(`/api/channels/${ch.id}/jobs`);
        const d = await r.json();
        if (d.total > 0 && d.active) {
          setJobStatus(prev => ({ ...prev, [ch.id]: d }));
          setWatchingIds(prev => prev.includes(ch.id) ? prev : [...prev, ch.id]);
          // Record approximate trigger time based on 2h window so polling stays consistent
          setWatchingSince(prev => ({ ...prev, [ch.id]: prev[ch.id] ?? Date.now() - 2 * 60 * 60 * 1000 }));
        }
      } catch {}
    }));
  }

  useEffect(() => { load(); }, []);

  function startPolling(id: string) {
    // Record trigger time minus 30s buffer so jobs created just before polling starts are included
    const since = Date.now() - 30_000;
    setWatchingSince(prev => ({ ...prev, [id]: since }));
    setWatchingIds(prev => prev.includes(id) ? prev : [...prev, id]);
    fetch(`/api/channels/${id}/jobs?since=${since}`)
      .then(r => r.json())
      .then(d => setJobStatus(prev => ({ ...prev, [id]: d })))
      .catch(() => {});
  }

  useEffect(() => {
    if (watchingIds.length === 0) return;
    const interval = setInterval(async () => {
      const done: string[] = [];
      await Promise.all(watchingIds.map(async id => {
        try {
          const since = watchingSince[id] ?? Date.now() - 2 * 60 * 60 * 1000;
          const r = await fetch(`/api/channels/${id}/jobs?since=${since}`);
          const d = await r.json();
          setJobStatus(prev => ({ ...prev, [id]: d }));
          if (!d.active) done.push(id);
        } catch {}
      }));
      if (done.length > 0) setWatchingIds(prev => prev.filter(id => !done.includes(id)));
    }, 3000);
    return () => clearInterval(interval);
  }, [watchingIds, watchingSince]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          backfillCount: backfillCount > 0 ? backfillCount : undefined,
          minDurationSeconds: minsToSecs(addMinMins),
          maxDurationSeconds: minsToSecs(addMaxMins),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to add channel');
      setUrl('');
      setShowAddOptions(false);
      await load();
      if (backfillCount > 0 && data.channel?.id) startPolling(data.channel.id);
    } catch (e: any) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleCheck(channel: Channel) {
    setCheckingId(channel.id);
    setCheckResult(r => ({ ...r, [channel.id]: '' }));
    try {
      const res = await fetch(`/api/channels/${channel.id}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const msg = data.enqueued === 0 ? 'Up to date' : `${data.enqueued} new episode${data.enqueued !== 1 ? 's' : ''} queued`;
      setCheckResult(r => ({ ...r, [channel.id]: msg }));
      await load();
      if (data.enqueued > 0) startPolling(channel.id);
    } catch (e: any) {
      setCheckResult(r => ({ ...r, [channel.id]: `Error: ${e.message}` }));
    } finally {
      setCheckingId(null);
    }
  }

  async function handleStopIngestion(channel: Channel) {
    await fetch(`/api/channels/${channel.id}/jobs/cancel`, { method: 'POST' });
    setJobStatus(prev => {
      const cur = prev[channel.id];
      if (!cur) return prev;
      return { ...prev, [channel.id]: { ...cur, active: false, queued: 0, running: 0, failed: cur.failed + cur.queued + cur.running } };
    });
    setWatchingIds(prev => prev.filter(id => id !== channel.id));
  }

  async function handleRemove(channel: Channel) {
    if (!confirm(`Remove "${channel.name}"? Episodes already ingested are kept.`)) return;
    const res = await fetch(`/api/channels/${channel.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(`Failed to unfollow: ${d.error ?? res.statusText}`);
      return;
    }
    await load();
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <div className="bg-[#080808] border-b border-[#181818]">
        <div className="max-w-3xl mx-auto px-4 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Channels</h1>
            <p className="text-xs text-[#666] mt-1">
              Follow podcasts. Configure episode length filters and check frequency per podcast.
            </p>
          </div>
          <div className="flex gap-5 text-xs">
            <Link href="/interests" className="text-[#C8900A] hover:text-[#e0a820] uppercase tracking-widest">My Feed</Link>
            <Link href="/episodes" className="text-[#555] hover:text-[#aaa] uppercase tracking-widest">Episodes</Link>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-4">

        {/* Top row: follow channel + ingest video */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Add channel */}
        <form onSubmit={handleAdd} className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-5">
          <h2 className="text-xs font-semibold text-[#888] mb-1 uppercase tracking-widest">Follow a channel</h2>
          <p className="text-[11px] text-[#444] mb-3">Type a podcast name, paste an RSS feed URL, or paste a Podcast Index URL.</p>

          <div className="flex gap-2 mb-3">
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="e.g. Acquired, All-In, or paste RSS/Podcast Index URL"
              className="flex-1 px-3 py-2 bg-[#080808] border border-[#222] rounded-lg text-sm text-white placeholder-[#333] focus:outline-none focus:ring-1 focus:ring-[#C8900A]/40"
            />
            <button
              type="button"
              onClick={() => setShowAddOptions(o => !o)}
              className="px-3 py-2 border border-[#222] bg-[#111] rounded-lg text-xs text-[#666] hover:border-[#333] hover:text-[#aaa] transition-colors"
            >
              Options {showAddOptions ? '▴' : '▾'}
            </button>
            <button
              type="submit"
              disabled={adding || !url.trim()}
              className="px-4 py-2 bg-[#C8900A] text-black rounded-lg text-xs font-bold hover:bg-[#a97208] disabled:opacity-50 transition-colors whitespace-nowrap uppercase tracking-widest"
            >
              {adding ? 'Adding…' : 'Follow'}
            </button>
          </div>

          {showAddOptions && (
            <div className="border border-[#1e1e1e] rounded-lg p-4 space-y-4 bg-[#080808]">
              <div>
                <div className="text-[10px] text-[#666] uppercase tracking-widest mb-2">Queue existing episodes</div>
                <div className="flex flex-wrap gap-1.5">
                  {BACKFILL_OPTIONS.map(opt => (
                    <button
                      key={opt.count}
                      type="button"
                      onClick={() => setBackfillCount(opt.count)}
                      className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
                        backfillCount === opt.count
                          ? 'bg-[#C8900A] border-[#C8900A] text-black font-bold'
                          : 'border-[#232323] bg-[#111] text-[#666] hover:border-[#C8900A]/50 hover:text-[#C8900A]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-[#444] mt-2">
                  Counts episodes that fall within your length filter from the Podcast Index feed.
                </p>
              </div>

              <div>
                <div className="text-[10px] text-[#666] uppercase tracking-widest mb-2">Episode length filter</div>
                <div className="flex gap-4 flex-wrap">
                  <DurationField label="Minimum" valueMins={addMinMins} onChange={setAddMinMins} allowNull={false} />
                  <DurationField label="Maximum" valueMins={addMaxMins} onChange={setAddMaxMins} allowNull nullLabel="No max" />
                </div>
              </div>
            </div>
          )}

          {addError && <p className="text-xs text-red-400 mt-2">{addError}</p>}
        </form>

        {/* Ingest a single episode */}
        <IngestionForm onSuccess={load} />

        </div>{/* end top row */}

        {/* Channel list */}
        {channels.length === 0 ? (
          <div className="text-center py-16 text-[#333] text-sm">No channels followed yet.</div>
        ) : (
          <div className="space-y-3 max-w-5xl">
            {channels.map(ch => (
              <div key={ch.id} className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-semibold text-white">{ch.name}</span>
                      {ch.searchQuery
                        ? <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-[#C8900A]/40 text-[#C8900A]/80">Search</span>
                        : <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] shrink-0" title="RSS feed" />
                      }
                      <span className="text-[11px] text-[#555]">{ch.episodeCount} ep{ch.episodeCount !== 1 ? 's' : ''}</span>
                    </div>
                    {ch.searchQuery
                      ? <span className="text-[11px] text-[#444]">"{ch.searchQuery}"</span>
                      : <a href={ch.url} target="_blank" rel="noopener noreferrer"
                          className="text-[11px] text-[#444] hover:text-[#C8900A] truncate block transition-colors">{ch.url}</a>
                    }

                    <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[#444] flex-wrap">
                      <span>
                        Checks every {ch.checkIntervalHours < 1
                          ? `${ch.checkIntervalHours * 60}m`
                          : `${ch.checkIntervalHours}h`}
                      </span>
                      <span className="text-[#222]">·</span>
                      <span>Last check: {timeAgo(ch.lastCheckedAt)}</span>
                      {ch.minDurationSeconds !== null && (
                        <>
                          <span className="text-[#222]">·</span>
                          <span>
                            {Math.round(ch.minDurationSeconds / 60)}m min
                            {ch.maxDurationSeconds !== null ? ` – ${Math.round(ch.maxDurationSeconds / 60)}m max` : '+'}
                          </span>
                        </>
                      )}
                      {checkResult[ch.id] && (
                        <>
                          <span className="text-[#222]">·</span>
                          <span className="text-[#C8900A]">{checkResult[ch.id]}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5 shrink-0 items-end">
                    <button
                      onClick={() => handleCheck(ch)}
                      disabled={checkingId === ch.id}
                      className="text-xs px-3 py-1.5 bg-[#141414] border border-[#222] text-[#C8900A] hover:bg-[#1a1a1a] hover:border-[#C8900A]/40 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
                    >
                      {checkingId === ch.id ? 'Checking…' : 'Check now'}
                    </button>
                    <button
                      onClick={() => setExpandedId(expandedId === ch.id ? null : ch.id)}
                      className="text-[11px] text-[#444] hover:text-[#888] transition-colors"
                    >
                      {expandedId === ch.id ? 'Hide settings ▴' : 'Settings ▾'}
                    </button>
                    <button
                      onClick={() => handleRemove(ch)}
                      className="text-[11px] text-[#333] hover:text-red-400 transition-colors"
                    >
                      Unfollow
                    </button>
                  </div>
                </div>

                {expandedId === ch.id && (
                  <ChannelSettings channel={ch} onSaved={load} />
                )}

                {jobStatus[ch.id] && jobStatus[ch.id].total > 0 && (
                  <div className="mt-3 pt-3 border-t border-[#1e1e1e]">
                    <div className="flex items-center justify-between mb-1.5 text-[10px]">
                      <span className={`text-[#666] ${jobStatus[ch.id].active ? 'animate-pulse' : ''}`}>
                        {jobStatus[ch.id].active
                          ? `${jobStatus[ch.id].completed} / ${jobStatus[ch.id].total} episodes processed`
                          : `${jobStatus[ch.id].completed} / ${jobStatus[ch.id].total} complete`}
                        {jobStatus[ch.id].running > 0 && (
                          <span className="ml-1.5 text-[#C8900A]">· {jobStatus[ch.id].running} running</span>
                        )}
                      </span>
                      <div className="flex items-center gap-3">
                        {jobStatus[ch.id].failed > 0 && (
                          <span className="text-red-400">{jobStatus[ch.id].failed} failed</span>
                        )}
                        {jobStatus[ch.id].active && (
                          <button
                            onClick={() => handleStopIngestion(ch)}
                            className="text-[10px] text-red-400 hover:text-red-300 transition-colors uppercase tracking-widest"
                          >
                            Stop
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="h-1 bg-[#1a1a1a] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-[width] duration-700 ${
                          !jobStatus[ch.id].active
                            ? (jobStatus[ch.id].failed > 0 && jobStatus[ch.id].completed === 0 ? 'bg-red-600' : 'bg-emerald-600')
                            : 'bg-[#C8900A]'
                        }`}
                        style={{ width: `${Math.max(jobStatus[ch.id].total > 0 ? 2 : 0, jobStatus[ch.id].overallProgress)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
