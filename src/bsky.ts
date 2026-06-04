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
  const thumbnailBlob = await fetchThumbnailBlob(entry.thumbnailUrl);
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

async function storeSession(env: SessionEnv, session: AtpSessionData): Promise<void> {
  await env.SESSION_KV.put(getSessionKey(env.BSKY_USERNAME), JSON.stringify(session));
}
