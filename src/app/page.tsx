import { SearchBar } from '@/components/SearchBar';
import { IngestionForm } from '@/components/IngestionForm';
import { db } from '@/lib/db';

export default async function Home() {
  // Fetch sources for ingestion form
  const sources = await db.source.findMany({
    select: { id: true, name: true },
  });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <h1 className="text-3xl font-bold text-gray-900">Podcast Intelligence</h1>
          <p className="text-gray-600 mt-2">
            Investor-focused transcript intelligence feed. Search and explore financial podcasts.
          </p>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="grid gap-8 md:grid-cols-3">
          {/* Search section */}
          <div className="md:col-span-2 space-y-6">
            <div className="bg-white rounded-lg p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Search by Ticker</h2>
              <SearchBar />
              <p className="text-sm text-gray-500 mt-3">
                Search for a ticker symbol (e.g., NVDA, TSLA) to view a personalized feed of mentions.
              </p>
            </div>

            {/* Info sections */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
              <h3 className="font-semibold text-blue-900 mb-2">📊 What is this?</h3>
              <p className="text-sm text-blue-800">
                This platform transforms financial podcasts into searchable, high-signal feeds.
                Find mentions of your favorite stocks, companies, and investment topics with confidence and novelty scores.
              </p>
            </div>

            <div className="bg-green-50 border border-green-200 rounded-lg p-6">
              <h3 className="font-semibold text-green-900 mb-2">⚡ Try it now</h3>
              <p className="text-sm text-green-800 mb-2">
                Some pre-seeded sources are ready to explore:
              </p>
              <ul className="text-sm text-green-800 space-y-1">
                <li>• <strong>All-In Podcast</strong> — E166 (seed episode)</li>
                <li>• <strong>Acquired</strong> — Deep dives on tech companies</li>
                <li>• <strong>Dwarkesh Podcast</strong> — Long-form interviews</li>
              </ul>
            </div>
          </div>

          {/* Ingestion form */}
          <div>
            <IngestionForm sources={sources} />
          </div>
        </div>
      </div>
    </div>
  );
}
