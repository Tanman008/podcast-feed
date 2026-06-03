import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import crypto from 'crypto';

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
  // Test known filter params on byperson
  const tests: { label: string; params: Record<string, string> }[] = [
    { label: 'no filter', params: { q: 'Satya Nadella' } },
    { label: 'notAIGenerated=1', params: { q: 'Satya Nadella', notAIGenerated: '1' } },
    { label: 'clean=1', params: { q: 'Satya Nadella', clean: '1' } },
    { label: 'max=10', params: { q: 'Satya Nadella', max: '10' } },
  ];

  for (const { label, params } of tests) {
    const data = await piGet('search/byperson', params);
    const items = data.items ?? [];
    const feeds = [...new Set(items.map((i: any) => i.feedTitle))];
    console.log(`\n[${label}]  items=${items.length}  unique_feeds=${feeds.length}`);
    console.log('  feeds:', feeds.slice(0, 5).join(', '));
  }
}
main();
