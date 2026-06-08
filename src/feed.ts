import { DOMParser } from '@xmldom/xmldom';
import type { FeedConfig, FeedConfigDocument, FeedEntry } from './types';

const ELEMENT_NODE = 1;

export async function fetchFeedConfig(feedConfigUrl: string): Promise<FeedConfig[]> {
  const response = await fetch(feedConfigUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch feed configuration: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as FeedConfigDocument;
  if (!payload || !Array.isArray(payload.check_feeds)) {
    throw new Error('Feed configuration JSON must contain a check_feeds array.');
  }

  const deduped = new Map<string, FeedConfig>();

  for (const item of payload.check_feeds) {
    if (!item || typeof item.title !== 'string' || typeof item.url !== 'string') {
      throw new Error('Each feed definition must contain string title and url fields.');
    }

    const title = item.title.trim();
    const url = item.url.trim();
    if (!title || !url) {
      throw new Error('Feed definitions must not contain empty title or url values.');
    }

    deduped.set(url, { title, url });
  }

  return Array.from(deduped.values());
}

export async function fetchFeedEntries(
  feed: FeedConfig,
  maxEntries?: number,
): Promise<FeedEntry[]> {
  const response = await fetch(feed.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch feed ${feed.url}: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  return parseFeedXml(xml, feed, maxEntries);
}

export function parseFeedXml(xml: string, feed: FeedConfig, maxEntries?: number): FeedEntry[] {
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const parserErrors = document.getElementsByTagName('parsererror');
  if (parserErrors.length > 0) {
    throw new Error(`Failed to parse XML for ${feed.url}`);
  }

  const root = document.documentElement;
  const rootName = getLocalName(root);

  if (rootName === 'feed') {
    return parseAtomEntries(root, feed, maxEntries);
  }

  if (rootName === 'rss' || rootName === 'rdf') {
    return parseRssEntries(root, feed, maxEntries);
  }

  if (findDescendants(root, 'entry').length > 0) {
    return parseAtomEntries(root, feed, maxEntries);
  }

  if (findDescendants(root, 'item').length > 0) {
    return parseRssEntries(root, feed, maxEntries);
  }

  throw new Error(`Unsupported feed format for ${feed.url}`);
}

function parseRssEntries(root: Element, feed: FeedConfig, maxEntries?: number): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const item of findDescendants(root, 'item')) {
    const entry = buildRssEntry(item, feed);
    if (entry) {
      entries.push(entry);
    }
  }

  return selectEntriesForPosting(entries, maxEntries);
}

function parseAtomEntries(root: Element, feed: FeedConfig, maxEntries?: number): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const entryElement of findDescendants(root, 'entry')) {
    const entry = buildAtomEntry(entryElement, feed);
    if (entry) {
      entries.push(entry);
    }
  }

  return selectEntriesForPosting(entries, maxEntries);
}

function buildRssEntry(item: Element, feed: FeedConfig): FeedEntry | null {
  const entryUrl = normalizeUrl(getFirstChildText(item, ['link']), feed.url);
  if (!entryUrl) {
    return null;
  }

  const title = getFirstChildText(item, ['title']) ?? entryUrl;
  return {
    feedTitle: feed.title,
    feedUrl: feed.url,
    title,
    entryUrl,
    publishedAt: normalizeDateString(getFirstChildText(item, ['pubDate', 'date'])),
    thumbnailUrl: extractRssThumbnail(item, feed.url),
  };
}

function buildAtomEntry(entry: Element, feed: FeedConfig): FeedEntry | null {
  const linkElement = childElements(entry).find((element) => {
    if (getLocalName(element) !== 'link') {
      return false;
    }

    const rel = element.getAttribute('rel');
    return !rel || rel === 'alternate';
  });

  const entryUrl =
    normalizeUrl(linkElement?.getAttribute('href'), feed.url) ??
    normalizeUrl(getFirstChildText(entry, ['id']), feed.url);

  if (!entryUrl) {
    return null;
  }

  const title = getFirstChildText(entry, ['title']) ?? entryUrl;
  return {
    feedTitle: feed.title,
    feedUrl: feed.url,
    title,
    entryUrl,
    publishedAt: normalizeDateString(getFirstChildText(entry, ['published', 'updated'])),
    thumbnailUrl: extractAtomThumbnail(entry, feed.url),
  };
}

function extractRssThumbnail(item: Element, baseUrl: string): string | null {
  for (const element of childElements(item)) {
    const name = getLocalName(element);
    const url = normalizeUrl(element.getAttribute('url'), baseUrl);
    const type = element.getAttribute('type')?.toLowerCase() ?? '';

    if (name === 'thumbnail' && url) {
      return url;
    }

    if (
      (name === 'content' || name === 'enclosure') &&
      url &&
      (!type || type.startsWith('image/'))
    ) {
      return url;
    }
  }

  return null;
}

function extractAtomThumbnail(entry: Element, baseUrl: string): string | null {
  for (const element of childElements(entry)) {
    if (getLocalName(element) !== 'link') {
      continue;
    }

    const rel = element.getAttribute('rel')?.toLowerCase();
    const type = element.getAttribute('type')?.toLowerCase() ?? '';
    const url = normalizeUrl(element.getAttribute('href'), baseUrl);
    if (url && rel === 'enclosure' && (!type || type.startsWith('image/'))) {
      return url;
    }
  }

  for (const element of findDescendants(entry, 'thumbnail')) {
    const url = normalizeUrl(element.getAttribute('url'), baseUrl);
    if (url) {
      return url;
    }
  }

  return null;
}

function dedupeEntries(entries: FeedEntry[]): FeedEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.entryUrl)) {
      return false;
    }

    seen.add(entry.entryUrl);
    return true;
  });
}

function selectEntriesForPosting(entries: FeedEntry[], maxEntries?: number): FeedEntry[] {
  const deduped = dedupeEntries(entries);
  const limit = typeof maxEntries === 'number' && maxEntries > 0 ? maxEntries : undefined;

  if (!limit || deduped.length <= limit) {
    return deduped.sort(compareEntriesByPublishedAt);
  }

  const selected: FeedEntry[] = [];

  for (const entry of deduped) {
    if (selected.length < limit) {
      selected.push(entry);
      continue;
    }

    const candidateTime = getEntrySortTime(entry);
    let oldestIndex = 0;
    let oldestTime = getEntrySortTime(selected[0]);

    for (let index = 1; index < selected.length; index += 1) {
      const currentTime = getEntrySortTime(selected[index]);
      if (currentTime < oldestTime) {
        oldestTime = currentTime;
        oldestIndex = index;
      }
    }

    if (candidateTime > oldestTime) {
      selected[oldestIndex] = entry;
    }
  }

  return selected.sort(compareEntriesByPublishedAt);
}

function getEntrySortTime(entry: FeedEntry): number {
  return entry.publishedAt ? Date.parse(entry.publishedAt) : Number.MAX_SAFE_INTEGER;
}

function compareEntriesByPublishedAt(left: FeedEntry, right: FeedEntry): number {
  const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : Number.MAX_SAFE_INTEGER;
  const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : Number.MAX_SAFE_INTEGER;
  return leftTime - rightTime;
}

function getFirstChildText(parent: Element, names: string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const child = childElements(parent).find((element) => wanted.has(getLocalName(element)));
  return normalizeText(child?.textContent);
}

function childElements(parent: Element): Element[] {
  const elements: Element[] = [];

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === ELEMENT_NODE) {
      elements.push(child as Element);
    }
  }

  return elements;
}

function findDescendants(parent: Element, name: string): Element[] {
  const normalizedName = name.toLowerCase();
  return Array.from(parent.getElementsByTagName('*')).filter(
    (element): element is Element => getLocalName(element) === normalizedName,
  );
}

function getLocalName(element: Element): string {
  return (element.localName ?? element.nodeName).split(':').pop()?.toLowerCase() ?? '';
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeDateString(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function normalizeUrl(value: string | null | undefined, baseUrl: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}
