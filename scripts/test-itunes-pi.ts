import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import crypto from 'crypto';

async function itunesSearch(term: string, entity: 'podcastEpisode' | 'podcast', limit = 10) {
  const qs = new URLSearchParams({ term, media: 'podcast', entity, limit: String(limit) }).toString();
  const res = await fetch(`https://itunes.apple.com/search?${qs}`);
  const data = await res.json();
  return data.results ?? [];
}

async function piGet(path: string, params: Record<string, string> = {}) {
  const key    = process.env.PODCAST_INDEX_API_KEY!;
  const secretB64 = process.env.PODCAST_INDEX_API_SECRET_B64;
  const secret = secretB64 ? Buffer.from(secretB64, 'base64').toString('utf8') : process.env.PODCAST_INDEX_API_SECRET!;
  const epoch  = Math.floor(Date.now() / 1000).toString();
  const hash   = crypto.createHash('sha1').update(key + secret + epoch).digest('hex');
  const qs     = new URLSearchParams(params).toString();
  const res    = await fetch(`https://api.podcastindex.org/api/1.0/${path}?${qs}`, {
    headers: { 'X-Auth-Key': key, 'X-Auth-Date': epoch, Authorization: hash, 'User-Agent': 'PodcastFeedApp/1.0' },
  });
  return res.json();
}

async function main() {
  console.log('=== iTunes episode search for "Satya Nadella" ===\n');
  const episodeResults = await itunesSearch('Satya Nadella', 'podcastEpisode', 10);
  console.log(`Found ${episodeResults.length} episode results`);
  for (const r of episodeResults.slice(0, 5)) {
    console.log(`  trackId=${r.trackId}  collectionId=${r.collectionId}`);
    console.log(`  show: ${r.collectionName}`);
    console.log(`  ep:   ${r.trackName}`);
    console.log(`  url:  ${r.episodeUrl?.slice(0, 60)}`);
    console.log();
  }

  // Try PI episodesByItunesId with a trackId from the iTunes results
  if (episodeResults.length > 0) {
    const trackId = episodeResults[0].trackId;
    console.log(`\n=== PI lookup: episodes/byitunesid?id=${trackId} ===`);
    const piData = await piGet('episodes/byitunesid', { id: String(trackId) });
    console.log('PI response keys:', Object.keys(piData));
    console.log('items count:', piData.items?.length ?? piData.episode ? 1 : 0);
    console.log(JSON.stringify(piData).slice(0, 400));
  }

  // Also try podcast search → get collectionIds → PI lookup by itunesId
  console.log('\n=== iTunes podcast search for "Satya Nadella" ===');
  const podcastResults = await itunesSearch('Satya Nadella', 'podcast', 5);
  console.log(`Found ${podcastResults.length} podcast results`);
  for (const r of podcastResults) {
    console.log(`  collectionId=${r.collectionId}  name="${r.collectionName}"`);
    // Try PI lookup by feed iTunes ID
    const piFeeds = await piGet('podcasts/byitunesid', { id: String(r.collectionId) });
    const feedId = piFeeds.feed?.id;
    console.log(`  PI feedId=${feedId ?? 'not found'}`);
  }
}

main();
