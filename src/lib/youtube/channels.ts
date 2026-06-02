// Resolve a YouTube channel URL (any format) to a stable channel ID.
// Supports:
//   https://www.youtube.com/channel/UCxxxxxx   ← direct
//   https://www.youtube.com/@handle             ← needs page fetch
//   https://www.youtube.com/c/name              ← needs page fetch

export interface ChannelInfo {
  channelId: string;   // UCxxxxxx
  name: string;
  rssUrl: string;      // https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxx
  canonicalUrl: string; // https://www.youtube.com/channel/UCxxxxxx
}

export async function resolveChannel(inputUrl: string): Promise<ChannelInfo | null> {
  const url = inputUrl.trim().replace(/\/$/, '');

  // Already a /channel/UC... URL — extract directly
  const directMatch = url.match(/youtube\.com\/channel\/(UC[\w-]+)/);
  if (directMatch) {
    const channelId = directMatch[1];
    return buildInfo(channelId, await fetchChannelName(channelId));
  }

  // @handle or /c/ URL — fetch the page and extract channel ID from HTML
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; podcast-intelligence/1.0)' },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Try og:url meta tag (most reliable)
    const ogUrl = html.match(/property="og:url"\s+content="([^"]+)"/)?.[1]
      ?? html.match(/content="([^"]+)"\s+property="og:url"/)?.[1];
    if (ogUrl) {
      const m = ogUrl.match(/youtube\.com\/channel\/(UC[\w-]+)/);
      if (m) {
        const channelId = m[1];
        const name = extractName(html);
        return buildInfo(channelId, name);
      }
    }

    // Fallback: look for channelId in page JSON blobs
    const jsonMatch = html.match(/"channelId"\s*:\s*"(UC[\w-]+)"/);
    if (jsonMatch) {
      const channelId = jsonMatch[1];
      return buildInfo(channelId, extractName(html));
    }

    return null;
  } catch {
    return null;
  }
}

function extractName(html: string): string {
  return (
    html.match(/<title>([^<]+) - YouTube<\/title>/)?.[1]?.trim() ??
    html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.trim() ??
    'Unknown channel'
  );
}

async function fetchChannelName(channelId: string): Promise<string> {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; podcast-intelligence/1.0)' },
    });
    const html = await res.text();
    return extractName(html);
  } catch {
    return 'Unknown channel';
  }
}

function buildInfo(channelId: string, name: string): ChannelInfo {
  return {
    channelId,
    name,
    rssUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    canonicalUrl: `https://www.youtube.com/channel/${channelId}`,
  };
}

// Parse the RSS feed and return video IDs + titles published after `since`
export interface FeedEntry {
  videoId: string;
  title: string;
  published: Date;
}

export async function fetchChannelFeed(channelId: string): Promise<FeedEntry[]> {
  try {
    const res = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
      { headers: { 'User-Agent': 'podcast-intelligence/1.0' } }
    );
    if (!res.ok) return [];
    const xml = await res.text();

    const entries: FeedEntry[] = [];
    for (const [, body] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const videoId = body.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1];
      const title = body.match(/<title>(.*?)<\/title>/)?.[1]
        ?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const published = body.match(/<published>(.*?)<\/published>/)?.[1];
      if (videoId && title && published) {
        entries.push({ videoId, title, published: new Date(published) });
      }
    }
    return entries;
  } catch {
    return [];
  }
}
