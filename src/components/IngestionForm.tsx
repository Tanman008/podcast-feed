// src/components/IngestionForm.tsx
// YouTube video ingestion form with progress polling

'use client';

import { useState, useEffect } from 'react';

interface Source {
  id: string;
  name: string;
}

interface IngestionFormProps {
  sources: Source[];
}

export function IngestionForm({ sources }: IngestionFormProps) {
  const [videoUrl, setVideoUrl] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'queued' | 'running' | 'completed' | 'failed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll job status while ingesting
  useEffect(() => {
    if (!jobId || !['queued', 'running'].includes(status || '')) return;

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/ingest/jobs/${jobId}`);
        if (!response.ok) throw new Error('Failed to fetch job status');

        const data = await response.json();
        setProgress(data.progress);
        setStatus(data.status);

        if (data.status === 'failed') {
          setError(data.errorMessage);
        }

        if (data.status === 'completed') {
          setTimeout(() => {
            setJobId(null);
            setProgress(0);
            setVideoUrl('');
            setError(null);
          }, 1000);
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
      const response = await fetch('/api/ingest/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl, sourceId }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to enqueue job');
      }

      const data = await response.json();
      setJobId(data.jobId);
      setStatus('queued');
      setProgress(0);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (jobId) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-2">Ingestion in Progress</h3>
        <div className="space-y-2">
          <div>
            <div className="flex justify-between text-sm text-blue-700 mb-1">
              <span>{status === 'running' ? 'Processing...' : 'Queued...'}</span>
              <span>{progress}%</span>
            </div>
            <div className="bg-blue-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
          {status === 'completed' && (
            <p className="text-green-700 text-sm">✓ Complete!</p>
          )}
          {error && <p className="text-red-700 text-sm">Error: {error}</p>}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
      <h3 className="font-semibold text-gray-900">Ingest a Video</h3>

      <div>
        <label className="block text-sm text-gray-700 mb-1">YouTube URL</label>
        <input
          type="url"
          placeholder="https://www.youtube.com/watch?v=..."
          value={videoUrl}
          onChange={e => setVideoUrl(e.target.value)}
          required
          className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm text-gray-700 mb-1">Source</label>
        <select
          value={sourceId}
          onChange={e => setSourceId(e.target.value)}
          required
          className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Select a source...</option>
          {sources.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
      >
        {loading ? 'Submitting...' : 'Ingest'}
      </button>
    </form>
  );
}
