import { AtpAgent, type AtpSessionData } from '@atproto/api';
import type { Env, FeedEntry } from './types';

const BLUESKY_SERVICE_URL = 'https://bsky.social';
const MAX_POST_GRAPHEMES = 300;
const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

type SessionEnv = Pick<Env, 'SESSION_KV' | 'BSKY_USERNAME' | 'BSKY_APP_PASSWORD'>;

export async function createBskyAgent(env: SessionEnv, ctx: ExecutionContext): Promise<AtpAgent> {
  const agent = new AtpAgent({
    service: BLUESKY_SERVICE_URL,
    persistSession: (_event, session) => {
      if (session) {
        ctx.waitUntil(storeSession(env, session));
      }
    },
  });

  const storedSession = await env.SESSION_KV.get(getSessionKey(env.BSKY_USERNAME), 'json');
  if (storedSession) {
    try {
      await agent.resumeSession(storedSession as AtpSessionData);
      return agent;
    } catch (error) {
      console.warn('Failed to resume Bluesky session, falling back to password login.', error);
    }
  }

  await agent.login({
    identifier: env.BSKY_USERNAME,
    password: env.BSKY_APP_PASSWORD,
  });

  if (agent.session) {
    ctx.waitUntil(storeSession(env, agent.session));
  }

  return agent;
}

export async function postFeedEntry(agent: AtpAgent, entry: FeedEntry): Promise<void> {
  const thumbnailBlob = await fetchThumbnailBlobForEntry(entry);
  const blobUpload = thumbnailBlob ? await agent.uploadBlob(thumbnailBlob) : null;

  await agent.post({
    $type: 'app.bsky.feed.post',
    text: buildPostText(entry),
    langs: ['ja'],
    embed: {
      $type: 'app.bsky.embed.external',
      external: {
        uri: entry.entryUrl,
        title: entry.title,
        description: entry.feedTitle,
        ...(blobUpload ? { thumb: blobUpload.data.blob } : {}),
      },
    },
  });
}

function buildPostText(entry: FeedEntry): string {
  return truncateGraphemes(`${entry.feedTitle}: ${entry.title}`, MAX_POST_GRAPHEMES);
}

async function fetchThumbnailBlobForEntry(entry: FeedEntry): Promise<Blob | null> {
  const feedThumbnail = await fetchThumbnailBlob(entry.thumbnailUrl);
  if (feedThumbnail) {
    return feedThumbnail;
  }

  const fallbackThumbnailUrl = await fetchPagePreviewImageUrl(entry.entryUrl);
  return fetchThumbnailBlob(fallbackThumbnailUrl);
}

async function fetchThumbnailBlob(thumbnailUrl: string | null): Promise<Blob | null> {
  if (!thumbnailUrl) {
    return null;
  }

  try {
    const response = await fetch(thumbnailUrl);
    if (!response.ok) {
      console.warn(`Skipping thumbnail upload because fetch failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch (error) {
    console.warn(`Skipping thumbnail upload because fetch threw for ${thumbnailUrl}.`, error);
    return null;
  }
}

async function fetchPagePreviewImageUrl(entryUrl: string): Promise<string | null> {
  try {
    const response = await fetch(entryUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) {
      console.warn(`Skipping preview image lookup because page fetch failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const html = await response.text();
    return extractPreviewImageUrl(html, entryUrl);
  } catch (error) {
    console.warn(`Skipping preview image lookup because page fetch threw for ${entryUrl}.`, error);
    return null;
  }
}

function extractPreviewImageUrl(html: string, baseUrl: string): string | null {
  const candidates = new Map<string, string>();

  for (const tag of html.match(/<meta\s+[^>]*>/gi) ?? []) {
    const attributes = parseHtmlAttributes(tag);
    const content = attributes.get('content');
    if (!content) {
      continue;
    }

    const key = attributes.get('property')?.toLowerCase() ?? attributes.get('name')?.toLowerCase();
    if (!key) {
      continue;
    }

    const normalizedUrl = normalizeUrl(content, baseUrl);
    if (!normalizedUrl) {
      continue;
    }

    candidates.set(key, normalizedUrl);
  }

  for (const key of ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']) {
    const candidate = candidates.get(key);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function parseHtmlAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const match of tag.matchAll(/([^\s"'=<>\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const [, rawName, doubleQuotedValue, singleQuotedValue, unquotedValue] = match;
    const value = doubleQuotedValue ?? singleQuotedValue ?? unquotedValue;
    if (value) {
      attributes.set(rawName.toLowerCase(), value);
    }
  }

  return attributes;
}

function truncateGraphemes(value: string, limit: number): string {
  const segments = Array.from(segmenter.segment(value));
  if (segments.length <= limit) {
    return value;
  }

  return `${segments
    .slice(0, Math.max(limit - 1, 0))
    .map((segment) => segment.segment)
    .join('')}…`;
}

function getSessionKey(username: string): string {
  return `bsky-session:${username}`;
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

async function storeSession(env: SessionEnv, session: AtpSessionData): Promise<void> {
  await env.SESSION_KV.put(getSessionKey(env.BSKY_USERNAME), JSON.stringify(session));
}
