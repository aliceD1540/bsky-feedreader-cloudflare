export interface Env {
  DB: D1Database;
  SESSION_KV: KVNamespace;
  FEED_CONFIG_URL: string;
  BSKY_USERNAME: string;
  BSKY_APP_PASSWORD: string;
  MAX_POSTS_PER_RUN?: string;
}

export interface FeedConfig {
  title: string;
  url: string;
}

export interface FeedConfigDocument {
  check_feeds: FeedConfig[];
}

export interface FeedEntry {
  feedTitle: string;
  feedUrl: string;
  title: string;
  entryUrl: string;
  publishedAt: string | null;
  thumbnailUrl: string | null;
}
