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
  const qs        = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const url       = `https://api.podcastindex.org/api/1.0/${path}${qs ? '?' + qs : ''}`;
  const res       = await fetch(url, {
    headers: { 'X-Auth-Key': key, 'X-Auth-Date': epoch, Authorization: hash, 'User-Agent': 'PodcastFeedApp/1.0' },
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  const names = ['Satya Nadella', 'Jensen Huang', 'Sam Altman', 'Elon Musk'];
  for (const name of names) {
    const r = await piGet('search/byperson', { q: name });
    const items = r.data?.items ?? [];
    console.log(`\n[${name}]  status=${r.status}  items=${items.length}`);
    for (const ep of items.slice(0, 3)) {
      const date = new Date((ep.datePublished ?? 0) * 1000).toISOString().slice(0, 10);
      console.log(`  ${date}  ${(ep.feedTitle ?? '').slice(0, 28).padEnd(28)}  ${(ep.title ?? '').slice(0, 50)}`);
    }
  }
}

main();
