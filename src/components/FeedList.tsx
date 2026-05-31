// src/components/FeedList.tsx
// Paginated feed list with sorting and filtering

'use client';

import { useState, useEffect } from 'react';
import { FeedCard } from './FeedCard';

interface Chunk {
  id: string;
  text: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  noveltyScore: number | null;
  convictionScore: number | null;
  speaker?: { id: string; name: string } | null;
  episode?: { id: string; title: string; publishedAt: string | null; source?: { name: string; platform: string } | null } | null;
}

interface Speaker {
  id: string;
  name: string;
}

interface FeedListProps {
  ticker: string;
}

export function FeedList({ ticker }: FeedListProps) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState<'recency' | 'novelty' | 'conviction'>('recency');
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [showSpeakerFilter, setShowSpeakerFilter] = useState(false);

  const [page, setPage] = useState(0);
  const LIMIT = 20;

  useEffect(() => {
    fetchFeed();
  }, [ticker, sort, speakerId, page]);

  async function fetchFeed() {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.append('sort', sort);
      params.append('limit', LIMIT.toString());
      params.append('offset', (page * LIMIT).toString());
      if (speakerId) params.append('speakerId', speakerId);

      const response = await fetch(`/api/feed/${ticker}?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch feed');

      const data = await response.json();
      setChunks(data.chunks);
      setTotal(data.total);
      setSpeakers(data.speakers || []);
      setShowSpeakerFilter(data.showSpeakerFilter || false);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return <div className="text-red-600 p-4">{error}</div>;
  }

  if (loading) {
    return <div className="text-gray-500 p-4">Loading...</div>;
  }

  if (chunks.length === 0) {
    return <div className="text-gray-500 p-4">No chunks found for {ticker}</div>;
  }

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="bg-gray-50 p-4 rounded-lg space-y-3">
        <div className="flex gap-3 flex-wrap">
          <div>
            <label className="text-sm text-gray-600">Sort by:</label>
            <select
              value={sort}
              onChange={e => {
                setSort(e.target.value as 'recency' | 'novelty' | 'conviction');
                setPage(0);
              }}
              className="ml-2 px-2 py-1 border border-gray-300 rounded text-sm"
            >
              <option value="recency">Recency</option>
              <option value="novelty">Novelty</option>
              <option value="conviction">Conviction</option>
            </select>
          </div>

          {showSpeakerFilter && speakers.length > 0 && (
            <div>
              <label className="text-sm text-gray-600">Speaker:</label>
              <select
                value={speakerId || ''}
                onChange={e => {
                  setSpeakerId(e.target.value || null);
                  setPage(0);
                }}
                className="ml-2 px-2 py-1 border border-gray-300 rounded text-sm"
              >
                <option value="">All speakers</option>
                {speakers.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="text-sm text-gray-600">
          Showing {page * LIMIT + 1}–{Math.min((page + 1) * LIMIT, total)} of {total} chunks
        </div>
      </div>

      {/* Chunks */}
      <div>
        {chunks.map(chunk => (
          <FeedCard key={chunk.id} chunk={chunk} />
        ))}
      </div>

      {/* Pagination */}
      <div className="flex justify-center gap-2">
        <button
          onClick={() => setPage(Math.max(0, page - 1))}
          disabled={page === 0}
          className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50"
        >
          Previous
        </button>

        <span className="px-3 py-1 text-sm text-gray-600">
          Page {page + 1} of {totalPages}
        </span>

        <button
          onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
          className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
