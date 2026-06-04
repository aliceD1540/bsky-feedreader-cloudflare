import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postedPayloads: Array<Record<string, unknown>> = [];
const loginMock = vi.fn();
const postMock = vi.fn(async (payload: Record<string, unknown>) => {
  postedPayloads.push(payload);
  return { uri: 'at://did:plc:test/app.bsky.feed.post/mock' };
});
const uploadBlobMock = vi.fn(async () => ({
  data: {
    blob: {
      $type: 'blob',
      ref: { $link: 'bafkreitest' },
      mimeType: 'image/jpeg',
      size: 4,
    },
  },
}));

vi.mock('@atproto/api', () => {
  class MockAtpAgent {
    private readonly options: { persistSession?: (event: string, session?: Record<string, unknown>) => void };
    session: Record<string, unknown> | null = null;

    constructor(options: { persistSession?: (event: string, session?: Record<string, unknown>) => void }) {
      this.options = options;
    }

    async resumeSession(session: Record<string, unknown>): Promise<void> {
      this.session = session;
    }

    async login(credentials: Record<string, unknown>): Promise<void> {
      loginMock(credentials);
      this.session = {
        did: 'did:plc:test',
        handle: 'example.bsky.social',
        accessJwt: 'access',
        refreshJwt: 'refresh',
      };
      this.options.persistSession?.('create', this.session);
    }

    async post(payload: Record<string, unknown>): Promise<{ uri: string }> {
      return postMock(payload);
    }

    async uploadBlob(): Promise<{ data: { blob: Record<string, unknown> } }> {
      return uploadBlobMock();
    }
  }

  return {
    AtpAgent: MockAtpAgent,
  };
});

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS feeds (
     feed_url TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     last_checked_at TEXT,
     last_success_at TEXT,
     last_error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS posted_entries (
     entry_url TEXT PRIMARY KEY,
     feed_url TEXT NOT NULL,
     title TEXT NOT NULL,
     published_at TEXT,
     thumbnail_url TEXT,
     state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'posted')),
     claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     posted_at TEXT,
     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY(feed_url) REFERENCES feeds(feed_url)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_posted_entries_feed_url ON posted_entries(feed_url)',
  'CREATE INDEX IF NOT EXISTS idx_posted_entries_state_claimed_at ON posted_entries(state, claimed_at)',
];

describe('scheduled worker', () => {
  beforeEach(async () => {
    postedPayloads.length = 0;
    loginMock.mockClear();
    postMock.mockClear();
    uploadBlobMock.mockClear();

    await env.DB.batch(schemaStatements.map((statement) => env.DB.prepare(statement)));
    await env.DB.exec('DELETE FROM posted_entries; DELETE FROM feeds;');

    vi.restoreAllMocks();
  });

  it('posts newly discovered entries and records them in D1', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === env.FEED_CONFIG_URL) {
        return jsonResponse({
          check_feeds: [{ title: 'Example Feed', url: 'https://example.com/feed.rdf' }],
        });
      }

      if (url === 'https://example.com/feed.rdf') {
        return textResponse(`<?xml version="1.0"?>
          <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
            <channel>
              <title>Example Feed</title>
              <item>
                <title>First entry</title>
                <link>https://example.com/posts/1</link>
                <pubDate>Tue, 03 Jun 2026 00:00:00 GMT</pubDate>
                <media:thumbnail url="https://example.com/thumb.jpg" />
              </item>
            </channel>
          </rss>`);
      }

      if (url === 'https://example.com/thumb.jpg') {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-type': 'image/jpeg' },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { runFeedPollJob } = await import('../src/index');
    const ctx = createExecutionContext();
    const summary = await runFeedPollJob(env, ctx);
    await waitOnExecutionContext(ctx);

    expect(summary).toEqual({
      feedsChecked: 1,
      claimedEntries: 1,
      postedEntries: 1,
      failedFeeds: 0,
      failedPosts: 0,
    });
    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postedPayloads[0]).toMatchObject({
      text: 'Example Feed: First entry',
    });

    const row = await env.DB.prepare(
      'SELECT feed_url, title, state FROM posted_entries WHERE entry_url = ?;',
    )
      .bind('https://example.com/posts/1')
      .first<{ feed_url: string; title: string; state: string }>();

    expect(row).toEqual({
      feed_url: 'https://example.com/feed.rdf',
      title: 'First entry',
      state: 'posted',
    });
  });

  it('releases claimed entries when posting fails so the next run can retry', async () => {
    let attempt = 0;
    postMock.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('temporary bluesky failure');
      }

      return { uri: 'at://did:plc:test/app.bsky.feed.post/retry' };
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === env.FEED_CONFIG_URL) {
        return jsonResponse({
          check_feeds: [{ title: 'Retry Feed', url: 'https://retry.example.com/feed.xml' }],
        });
      }

      if (url === 'https://retry.example.com/feed.xml') {
        return textResponse(`<?xml version="1.0" encoding="utf-8"?>
          <feed xmlns="http://www.w3.org/2005/Atom">
            <entry>
              <title>Retry entry</title>
              <link href="https://retry.example.com/posts/1" />
              <updated>2026-06-04T00:00:00Z</updated>
            </entry>
          </feed>`);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { runFeedPollJob } = await import('../src/index');

    const firstCtx = createExecutionContext();
    const firstSummary = await runFeedPollJob(env, firstCtx);
    await waitOnExecutionContext(firstCtx);

    expect(firstSummary.failedPosts).toBe(1);

    const afterFirstRunCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM posted_entries;').first<{
      count: number;
    }>();
    expect(afterFirstRunCount?.count).toBe(0);

    const secondCtx = createExecutionContext();
    const secondSummary = await runFeedPollJob(env, secondCtx);
    await waitOnExecutionContext(secondCtx);

    expect(secondSummary.postedEntries).toBe(1);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('deletes posted entries older than 30 days during the cleanup cron', async () => {
    await env.DB
      .prepare(
        `INSERT INTO feeds (feed_url, title)
         VALUES (?, ?);`,
      )
      .bind('https://example.com/feed.rdf', 'Example Feed')
      .run();

    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO posted_entries (
             entry_url,
             feed_url,
             title,
             state,
             claimed_at,
             posted_at
           )
           VALUES (?, ?, ?, 'posted', datetime('now', '-40 days'), datetime('now', '-40 days'));`,
        )
        .bind('https://example.com/posts/old', 'https://example.com/feed.rdf', 'Old Entry'),
      env.DB
        .prepare(
          `INSERT INTO posted_entries (
             entry_url,
             feed_url,
             title,
             state,
             claimed_at,
             posted_at
           )
           VALUES (?, ?, ?, 'posted', datetime('now', '-10 days'), datetime('now', '-10 days'));`,
        )
        .bind('https://example.com/posts/recent', 'https://example.com/feed.rdf', 'Recent Entry'),
    ]);

    const { runCleanupJob } = await import('../src/index');
    const summary = await runCleanupJob(env);

    expect(summary).toEqual({ deletedEntries: 1 });

    const rows = await env.DB
      .prepare('SELECT entry_url FROM posted_entries ORDER BY entry_url;')
      .all<{ entry_url: string }>();

    expect(rows.results).toEqual([{ entry_url: 'https://example.com/posts/recent' }]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'application/xml' },
  });
}
