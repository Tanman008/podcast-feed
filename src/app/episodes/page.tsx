// src/app/episodes/page.tsx — ingestion history and entity browser
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { db } from '@/lib/db';
import { DeleteEpisodeButton, ClearAllButton } from '@/components/DeleteEpisodeButton';

async function getEpisodes() {
  const episodes = await db.episode.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      source: { select: { name: true, platform: true } },
      _count: { select: { chunks: true } },
    },
  });

  const result = await Promise.all(
    episodes.map(async ep => {
      const links = await db.chunkEntity.findMany({
        where: { chunk: { episodeId: ep.id } },
        select: { entity: { select: { id: true, name: true, ticker: true, entityType: true } } },
        distinct: ['entityId'],
        take: 10,
      });
      return { ...ep, entities: links.map(l => l.entity) };
    })
  );

  return result;
}

const statusStyle: Record<string, string> = {
  completed: 'bg-emerald-900/30 text-emerald-400 border border-emerald-900/50',
  processing: 'bg-blue-900/30 text-blue-400 border border-blue-900/50',
  pending:    'bg-[#1a1a1a] text-[#666] border border-[#222]',
  failed:     'bg-red-900/30 text-red-400 border border-red-900/50',
};

export default async function EpisodesPage() {
  const episodes = await getEpisodes();

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <div className="bg-[#080808] border-b border-[#181818]">
        <div className="max-w-5xl mx-auto px-4 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Ingested Episodes</h1>
            <p className="text-xs text-[#666] mt-1">{episodes.length} episodes indexed</p>
          </div>
          <div className="flex items-center gap-4">
            {episodes.length > 0 && <ClearAllButton />}
            <Link href="/channels" className="text-xs text-[#555] hover:text-[#aaa] uppercase tracking-widest">← Channels</Link>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-3">
        {episodes.length === 0 && (
          <div className="text-center py-16 text-[#333] text-sm">
            No episodes ingested yet. Submit a YouTube URL on the home page.
          </div>
        )}

        {episodes.map(ep => (
          <div key={ep.id} className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] text-[#555] uppercase tracking-wide">
                    {ep.source.name}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusStyle[ep.transcriptStatus] ?? statusStyle.pending}`}>
                    {ep.transcriptStatus}
                  </span>
                </div>

                <h2 className="text-sm font-semibold text-[#ccc] leading-snug mb-1">
                  {ep.title}
                </h2>

                <div className="text-[11px] text-[#555] space-x-3">
                  <span>{ep._count.chunks} chunks</span>
                  <span>·</span>
                  <span>{ep.entities.length} entities</span>
                  <span>·</span>
                  <span>{new Date(ep.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <a
                  href={`https://youtu.be/${ep.externalId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[#555] hover:text-[#C8900A] transition-colors"
                >
                  ↗ YouTube
                </a>
                <DeleteEpisodeButton episodeId={ep.id} />
              </div>
            </div>

            {ep.entities.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {ep.entities.map(entity => (
                  <span
                    key={entity.id}
                    className="text-[10px] bg-[#141414] text-[#555] px-2 py-0.5 rounded border border-[#1e1e1e]"
                  >
                    {entity.ticker ?? entity.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
