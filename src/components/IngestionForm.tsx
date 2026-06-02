'use client';

import { useState, useEffect } from 'react';

export function IngestionForm() {
  const [videoUrl, setVideoUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'queued' | 'running' | 'completed' | 'failed' | null>(null);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
            setVideoUrl('');
            setChannelName(null);
            setVideoTitle(null);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/ingest/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to enqueue job');

      setJobId(data.jobId);
      setStatus('queued');
      setProgress(0);
      setChannelName(data.channelName ?? null);
      setVideoTitle(data.videoTitle ?? null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (jobId) {
    return (
      <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-5 space-y-3">
        <h3 className="text-xs font-semibold text-[#888] uppercase tracking-widest">Ingesting…</h3>
        {videoTitle && <p className="text-xs text-[#ccc] truncate">{videoTitle}</p>}
        {channelName && <p className="text-[11px] text-[#555]">{channelName}</p>}

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

        {status === 'completed' && (
          <p className="text-[11px] text-emerald-400 font-medium">✓ Done</p>
        )}
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-5 space-y-3">
      <h3 className="text-xs font-semibold text-[#888] uppercase tracking-widest">Ingest a video</h3>
      <p className="text-[11px] text-[#444]">
        Paste any public YouTube URL. Source is detected automatically from the channel.
      </p>

      <input
        type="url"
        placeholder="https://www.youtube.com/watch?v=..."
        value={videoUrl}
        onChange={e => setVideoUrl(e.target.value)}
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
  );
}
