'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function DeleteEpisodeButton({ episodeId }: { episodeId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleDelete() {
    setLoading(true);
    await fetch(`/api/episodes/${episodeId}`, { method: 'DELETE' });
    router.refresh();
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-[#555]">Sure?</span>
        <button
          onClick={handleDelete}
          disabled={loading}
          className="text-[11px] text-red-400 hover:underline disabled:opacity-50"
        >
          {loading ? 'Deleting…' : 'Yes, delete'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-[11px] text-[#444] hover:text-[#888]"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="text-[11px] text-[#333] hover:text-red-400 transition-colors"
      title="Delete episode"
    >
      ✕
    </button>
  );
}

export function ClearAllButton() {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleClear() {
    setLoading(true);
    await fetch('/api/episodes/clear', { method: 'DELETE' });
    router.refresh();
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-[#666]">Delete everything?</span>
        <button
          onClick={handleClear}
          disabled={loading}
          className="text-xs text-red-400 font-medium hover:underline disabled:opacity-50"
        >
          {loading ? 'Clearing…' : 'Yes, clear all'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-xs text-[#444] hover:text-[#888]"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="text-xs text-red-500 hover:text-red-400 border border-red-900/40 hover:border-red-500/60 px-3 py-1.5 rounded-lg transition-colors"
    >
      Clear all
    </button>
  );
}
