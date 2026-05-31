// src/app/feed/[ticker]/page.tsx
// Ticker feed page showing chunks for a specific ticker

import { FeedList } from '@/components/FeedList';
import { SearchBar } from '@/components/SearchBar';

export default async function TickerFeedPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const upperTicker = ticker.toUpperCase();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">{upperTicker}</h1>
              <p className="text-gray-600 mt-1">Financial podcast mentions</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-6">
          <SearchBar />
        </div>

        {/* Feed */}
        <FeedList ticker={upperTicker} />
      </div>
    </div>
  );
}
