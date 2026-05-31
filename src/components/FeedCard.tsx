// src/components/FeedCard.tsx
// Display a single TranscriptChunk in feed list
// Shows text, timestamps, scores, speaker, source

'use client';

import { memo } from 'react';

interface FeedChunkProps {
  id: string;
  text: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  noveltyScore: number | null;
  convictionScore: number | null;
  speaker?: {
    id: string;
    name: string;
  } | null;
  episode?: {
    id: string;
    title: string;
    publishedAt: string | null;
    source?: {
      name: string;
      platform: string;
    } | null;
  } | null;
}

export const FeedCard = memo(function FeedCard({ chunk }: { chunk: FeedChunkProps }) {
  const formatScore = (score: number | null) => {
    if (score === null || score === undefined) return '—';
    return (score * 100).toFixed(0);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const publishDate = chunk.episode?.publishedAt
    ? new Date(chunk.episode.publishedAt).toLocaleDateString()
    : '';

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-3 hover:shadow-md transition-shadow">
      {/* Header: Source + Episode */}
      <div className="mb-3">
        <div className="text-sm text-gray-500">
          {chunk.episode?.source?.name && (
            <span>
              <strong>{chunk.episode.source.name}</strong>
              {publishDate && ` · ${publishDate}`}
            </span>
          )}
        </div>
        {chunk.episode?.title && (
          <h3 className="text-sm font-semibold text-gray-900 truncate">
            {chunk.episode.title}
          </h3>
        )}
      </div>

      {/* Chunk text */}
      <p className="text-gray-800 text-sm leading-relaxed mb-3 line-clamp-3">
        {chunk.text}
      </p>

      {/* Timestamp + Speaker */}
      <div className="flex items-center gap-3 text-xs text-gray-600 mb-3">
        <span className="bg-gray-100 px-2 py-1 rounded">
          {formatTime(chunk.startTimeSeconds)} – {formatTime(chunk.endTimeSeconds)}
        </span>
        {chunk.speaker && (
          <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded">
            {chunk.speaker.name}
          </span>
        )}
      </div>

      {/* Scores */}
      <div className="flex gap-4 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-gray-600">Novelty:</span>
          <span className="font-semibold">{formatScore(chunk.noveltyScore)}%</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-600">Conviction:</span>
          <span className="font-semibold">{formatScore(chunk.convictionScore)}%</span>
        </div>
      </div>
    </div>
  );
});
