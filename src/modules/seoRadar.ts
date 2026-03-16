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
  const res = await axios.get<string>(url, { headers: HEADERS, timeout: 12_000 });
  return res.data;
}

async function parseRss(xml: string, sourceName: string): Promise<DigestItem[]> {
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });

  const channel = parsed?.rss?.channel ?? parsed?.feed;
  if (!channel) return [];

  const rawItems: unknown[] = Array.isArray(channel.item ?? channel.entry)
    ? (channel.item ?? channel.entry)
    : [channel.item ?? channel.entry].filter(Boolean);

  return rawItems.slice(0, 8).map((raw: unknown) => {
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

    // Extract publish date to filter by recency
    const pubDateRaw = String(item.pubDate ?? item.published ?? item.updated ?? '');
    const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;

    return { title, link, summary, source: sourceName, pubDate };
  });
}

// ---------------------------------------------------------------------------
// RSS feed fetcher (generic)
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
// Search Engine Land — HTML scrape fallback
// ---------------------------------------------------------------------------

async function fetchSearchEngineLand(): Promise<DigestItem[]> {
  try {
    const res = await axios.get<string>('https://searchengineland.com/', {
      headers: HEADERS,
      timeout: 12_000,
    });
    const $ = cheerio.load(res.data);
    const items: DigestItem[] = [];

    $('article').each((_i, el) => {
      const titleEl = $(el).find('h2 a, h3 a').first();
      const title = titleEl.text().trim();
      const link = titleEl.attr('href') ?? '';
      const summary = $(el).find('p').first().text().trim().slice(0, 200);

      if (title && link) {
        items.push({ title, link, summary, source: 'Search Engine Land' });
      }
    });

    return items.slice(0, 8);
  } catch (err) {
    console.warn('[seoRadar] searchengineland.com scrape failed:', (err as Error).message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplicate by URL (ignore query params)
// ---------------------------------------------------------------------------

function deduplicate(items: DigestItem[]): DigestItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.link.split('?')[0];
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Filter by recency — prefer items from the last 7 days
// ---------------------------------------------------------------------------

function sortByRecency(items: (DigestItem & { pubDate?: Date | null })[]): DigestItem[] {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  return [...items].sort((a, b) => {
    // Items with recent pub date first
    const aDate = a.pubDate?.getTime() ?? 0;
    const bDate = b.pubDate?.getTime() ?? 0;
    const aRecent = now - aDate < sevenDaysMs;
    const bRecent = now - bDate < sevenDaysMs;

    if (aRecent && !bRecent) return -1;
    if (!aRecent && bRecent) return 1;
    return bDate - aDate; // newer first
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runSeoRadar(filter?: string): Promise<string> {
  const feeds: [string, string][] = [
    ['https://feeds.feedburner.com/SearchEngineLand', 'Search Engine Land'],
    ['https://www.semrush.com/blog/feed/', 'Semrush Blog'],
    ['https://neilpatel.com/blog/feed/', 'Neil Patel'],
    ['https://ahrefs.com/blog/feed/', 'Ahrefs Blog'],
    ['https://moz.com/blog/feed', 'Moz Blog'],
    ['https://www.searchenginejournal.com/feed/', 'Search Engine Journal'],
    ['https://developers.google.com/search/blog/feeds/posts/default', 'Google Search Central'],
  ];

  const results = await Promise.allSettled([
    ...feeds.map(([url, source]) => fetchRssFeed(url, source)),
    fetchSearchEngineLand(),
  ]);

  const all: (DigestItem & { pubDate?: Date | null })[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...(r.value as (DigestItem & { pubDate?: Date | null })[]));
  }

  const sorted = sortByRecency(all);
  const unique = deduplicate(sorted).slice(0, 15);

  console.log(`[seoRadar] Collected ${all.length} items, ${unique.length} unique (${feeds.length + 1} sources)`);

  return buildSeoDigest(unique, filter);
}
