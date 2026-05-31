// src/components/SearchBar.tsx
// Ticker search input and navigation to feed

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SearchBar() {
  const [ticker, setTicker] = useState('');
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (ticker.trim()) {
      router.push(`/feed/${ticker.toUpperCase()}`);
      setTicker('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        placeholder="Search ticker (e.g., NVDA, TSLA)"
        value={ticker}
        onChange={e => setTicker(e.target.value)}
        className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button
        type="submit"
        className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
      >
        Search
      </button>
    </form>
  );
}
