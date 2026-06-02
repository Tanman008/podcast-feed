import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import crypto from 'crypto';

async function piGet(path: string, params: Record<string, string | number> = {}) {
  const key       = process.env.PODCAST_INDEX_API_KEY!;
  const secretB64 = process.env.PODCAST_INDEX_API_SECRET_B64;
  const rawSecret = process.env.PODCAST_INDEX_API_SECRET;
  const secret    = secretB64 ? Buffer.from(secretB64, 'base64').toString('utf8') : rawSecret!;
  const epoch     = Math.floor(Date.now() / 1000).toString();
  const hash      = crypto.createHash('sha1').update(key + secret + epoch).digest('hex');
  const qs  = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const url = `https://api.podcastindex.org/api/1.0/${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: { 'X-Auth-Key': key, 'X-Auth-Date': epoch, Authorization: hash, 'User-Agent': 'PodcastFeedApp/1.0' },
  });
  if (!res.ok) throw new Error(`PI ${res.status}`);
  return res.json();
}

const nowSecs = Math.floor(Date.now() / 1000);
const cuts = { '1d': nowSecs - 86400, '7d': nowSecs - 7*86400, '30d': nowSecs - 30*86400 };

const terms = ['MSFT', 'Microsoft', 'Quantum', 'quantum computing', 'NVDA', 'NVIDIA', 'AI', 'bitcoin', 'software', 'DoorDash'];

async function main() {
  for (const term of terms) {
    try {
      const data = await piGet('search/byterm', { q: term, max: 40 });
      const feeds = data.feeds ?? [];
      const c1  = feeds.filter((f: any) => f.newestItemPubdate >= cuts['1d']).length;
      const c7  = feeds.filter((f: any) => f.newestItemPubdate >= cuts['7d']).length;
      const c30 = feeds.filter((f: any) => f.newestItemPubdate >= cuts['30d']).length;
      console.log(`[${term.padEnd(20)}]  feeds=${feeds.length}  active_1d=${c1}  active_7d=${c7}  active_30d=${c30}`);
    } catch (e: any) {
      console.log(`[${term.padEnd(20)}]  ERROR: ${e.message}`);
    }
  }
}

main();
