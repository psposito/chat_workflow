import axios from 'axios';
import * as xml2js from 'xml2js';
import * as cheerio from 'cheerio';
import { buildSeoDigest, DigestItem } from './seoDigest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (compatible; SEORadarBot/1.0; +https://github.com/whatsapp-bot)',
};

async function fetchXml(url: string): Promise<string> {
  const res = await axios.get<string>(url, { headers: HEADERS, timeout: 10_000 });
  return res.data;
}

async function parseRss(xml: string, sourceName: string): Promise<DigestItem[]> {
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });

  // Support both RSS 2.0 (<rss>) and Atom (<feed>)
  const channel = parsed?.rss?.channel ?? parsed?.feed;
  if (!channel) return [];

  const rawItems: unknown[] = Array.isArray(channel.item ?? channel.entry)
    ? (channel.item ?? channel.entry)
    : [channel.item ?? channel.entry].filter(Boolean);

  return rawItems.slice(0, 10).map((raw: unknown) => {
    const item = raw as Record<string, unknown>;
    const title = String(item.title ?? '').trim();
    const atomLink = (item as Record<string, Record<string, Record<string, string>>>)['link']?.['$']?.href;
    const link = String(item.link ?? atomLink ?? '').trim();
    const summary = String(
      item.summary ?? item.description ?? item['content:encoded'] ?? '',
    )
      .replace(/<[^>]+>/g, '')
      .slice(0, 200)
      .trim();

    return { title, link, summary, source: sourceName };
  });
}

// ---------------------------------------------------------------------------
// Source 1 & 3: RSS feeds
// ---------------------------------------------------------------------------

async function fetchRssFeed(url: string, source: string): Promise<DigestItem[]> {
  try {
    const xml = await fetchXml(url);
    return await parseRss(xml, source);
  } catch (err) {
    console.warn(`[seoRadar] RSS fetch failed for ${source}:`, (err as Error).message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source 2: Search Engine Land (HTML scrape via cheerio)
// ---------------------------------------------------------------------------

async function fetchSearchEngineLand(): Promise<DigestItem[]> {
  try {
    const res = await axios.get<string>('https://searchengineland.com/', {
      headers: HEADERS,
      timeout: 12_000,
    });
    const $ = cheerio.load(res.data);
    const items: DigestItem[] = [];

    // Article cards on the homepage
    $('article').each((_i, el) => {
      const titleEl = $(el).find('h2 a, h3 a').first();
      const title = titleEl.text().trim();
      const link = titleEl.attr('href') ?? '';
      const summary = $(el).find('p').first().text().trim().slice(0, 200);

      if (title && link) {
        items.push({ title, link, summary, source: 'Search Engine Land' });
      }
    });

    return items.slice(0, 10);
  } catch (err) {
    console.warn('[seoRadar] searchengineland.com scrape failed:', (err as Error).message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplicate by URL
// ---------------------------------------------------------------------------

function deduplicate(items: DigestItem[]): DigestItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.link.split('?')[0]; // ignore query params
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runSeoRadar(): Promise<string> {
  const [sel, seroundtable, searchConsoleCommunity, searchEngineLand] =
    await Promise.allSettled([
      fetchRssFeed('https://feeds.feedburner.com/SearchEngineLand', 'Search Engine Land (RSS)'),
      fetchRssFeed('https://www.seroundtable.com/feed', 'SE Roundtable'),
      fetchRssFeed(
        'https://support.google.com/webmasters/threads/feed?hl=pt-BR',
        'Search Console Community',
      ),
      fetchSearchEngineLand(),
    ]);

  const all: DigestItem[] = [
    ...(sel.status === 'fulfilled' ? sel.value : []),
    ...(seroundtable.status === 'fulfilled' ? seroundtable.value : []),
    ...(searchConsoleCommunity.status === 'fulfilled' ? searchConsoleCommunity.value : []),
    ...(searchEngineLand.status === 'fulfilled' ? searchEngineLand.value : []),
  ];

  const unique = deduplicate(all).slice(0, 10);

  console.log(`[seoRadar] Collected ${all.length} items, ${unique.length} unique`);

  return buildSeoDigest(unique);
}
