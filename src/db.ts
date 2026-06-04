import type { FeedConfig, FeedEntry } from './types';

const STALE_CLAIM_WINDOW_HOURS = 6;
const POST_RETENTION_DAYS = 30;

export async function syncFeeds(db: D1Database, feeds: FeedConfig[]): Promise<void> {
  if (feeds.length === 0) {
    return;
  }

  await db.batch(
    feeds.map((feed) =>
      db
        .prepare(
          `INSERT INTO feeds (feed_url, title)
           VALUES (?, ?)
           ON CONFLICT(feed_url) DO UPDATE SET title = excluded.title;`,
        )
        .bind(feed.url, feed.title),
    ),
  );
}

export async function markFeedCheckSuccess(db: D1Database, feed: FeedConfig): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds
       SET title = ?,
           last_checked_at = CURRENT_TIMESTAMP,
           last_success_at = CURRENT_TIMESTAMP,
           last_error = NULL
       WHERE feed_url = ?;`,
    )
    .bind(feed.title, feed.url)
    .run();
}

export async function markFeedCheckFailure(
  db: D1Database,
  feed: FeedConfig,
  errorMessage: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds
       SET title = ?,
           last_checked_at = CURRENT_TIMESTAMP,
           last_error = ?
       WHERE feed_url = ?;`,
    )
    .bind(feed.title, errorMessage, feed.url)
    .run();
}

export async function claimEntry(db: D1Database, entry: FeedEntry): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO posted_entries (
         entry_url,
         feed_url,
         title,
         published_at,
         thumbnail_url,
         state,
         claimed_at
       )
       VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
       ON CONFLICT(entry_url) DO UPDATE SET
         feed_url = excluded.feed_url,
         title = excluded.title,
         published_at = excluded.published_at,
         thumbnail_url = excluded.thumbnail_url,
         state = 'pending',
         claimed_at = CURRENT_TIMESTAMP
       WHERE posted_entries.state = 'pending'
         AND posted_entries.claimed_at <= datetime('now', ?);`,
    )
    .bind(
      entry.entryUrl,
      entry.feedUrl,
      entry.title,
      entry.publishedAt,
      entry.thumbnailUrl,
      `-${STALE_CLAIM_WINDOW_HOURS} hours`,
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function markEntryPosted(db: D1Database, entryUrl: string): Promise<void> {
  await db
    .prepare(
      `UPDATE posted_entries
       SET state = 'posted',
           posted_at = CURRENT_TIMESTAMP
       WHERE entry_url = ?;`,
    )
    .bind(entryUrl)
    .run();
}

export async function releaseEntryClaim(db: D1Database, entryUrl: string): Promise<void> {
  await db
    .prepare(`DELETE FROM posted_entries WHERE entry_url = ? AND state = 'pending';`)
    .bind(entryUrl)
    .run();
}

export async function purgeExpiredPostedEntries(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM posted_entries
       WHERE state = 'posted'
         AND posted_at IS NOT NULL
         AND posted_at < datetime('now', ?);`,
    )
    .bind(`-${POST_RETENTION_DAYS} days`)
    .run();

  return result.meta.changes ?? 0;
}
