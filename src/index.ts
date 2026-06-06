import * as bsky from './bsky';
import * as db from './db';
import { fetchFeedConfig, fetchFeedEntries } from './feed';
import type { Env, FeedConfig, FeedEntry } from './types';

const FEED_POLL_CRON = '*/10 * * * *';
const CLEANUP_CRON = '0 15 * * *';

interface ScheduledSummary {
  totalFeeds: number;
  feedsChecked: number;
  claimedEntries: number;
  postedEntries: number;
  failedFeeds: number;
  failedPosts: number;
}

interface CleanupSummary {
  deletedEntries: number;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    return Response.json({
      ok: true,
      message: 'Use the scheduled trigger to poll feeds or purge expired history.',
      healthcheck: '/health',
    });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === CLEANUP_CRON) {
      const summary = await runCleanupJob(env);
      console.log('Cleanup run finished.', summary);
      return;
    }

    const summary = await runFeedPollJob(env, ctx);
    console.log('Feed polling run finished.', { cron: controller.cron, ...summary });
  },
} satisfies ExportedHandler<Env>;

export async function runFeedPollJob(env: Env, ctx: ExecutionContext): Promise<ScheduledSummary> {
  const feeds = await fetchFeedConfig(env.FEED_CONFIG_URL);
  await db.syncFeeds(env.DB, feeds);

  const feedsForRun = await selectFeedsForRun(env, feeds);
  const maxEntriesPerFeed = getMaxEntriesPerFeed(env.MAX_ENTRIES_PER_FEED);

  const perFeedResults = await Promise.allSettled(
    feedsForRun.map((feed) => fetchAndTrackFeed(env, feed, maxEntriesPerFeed)),
  );

  const summary: ScheduledSummary = {
    totalFeeds: feeds.length,
    feedsChecked: feedsForRun.length,
    claimedEntries: 0,
    postedEntries: 0,
    failedFeeds: 0,
    failedPosts: 0,
  };

  const claimQueue: FeedEntry[] = [];
  const maxPosts = getMaxPostsPerRun(env.MAX_POSTS_PER_RUN);

  for (const result of perFeedResults) {
    if (result.status === 'rejected') {
      summary.failedFeeds += 1;
      console.error('Unexpected failure while processing feed.', result.reason);
      continue;
    }

    if (result.value.error) {
      summary.failedFeeds += 1;
      continue;
    }

    for (const entry of result.value.entries) {
      if (summary.claimedEntries >= maxPosts) {
        break;
      }

      if (await db.claimEntry(env.DB, entry)) {
        claimQueue.push(entry);
        summary.claimedEntries += 1;
      }
    }
  }

  if (claimQueue.length === 0) {
    return summary;
  }

  const agent = await bsky.createBskyAgent(env, ctx);

  for (const entry of claimQueue) {
    try {
      await bsky.postFeedEntry(agent, entry);
      await db.markEntryPosted(env.DB, entry.entryUrl);
      summary.postedEntries += 1;
    } catch (error) {
      summary.failedPosts += 1;
      await db.releaseEntryClaim(env.DB, entry.entryUrl);
      console.error(`Failed to post entry ${entry.entryUrl}.`, error);
    }
  }

  return summary;
}

export async function runCleanupJob(env: Env): Promise<CleanupSummary> {
  const deletedEntries = await db.purgeExpiredPostedEntries(env.DB);
  return { deletedEntries };
}

async function fetchAndTrackFeed(
  env: Env,
  feed: FeedConfig,
  maxEntriesPerFeed: number,
): Promise<{ entries: FeedEntry[]; error: Error | null }> {
  try {
    const entries = await fetchFeedEntries(feed);
    await db.markFeedCheckSuccess(env.DB, feed);
    return { entries: entries.slice(-maxEntriesPerFeed), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.markFeedCheckFailure(env.DB, feed, message);
    console.error(`Failed to process feed ${feed.url}.`, error);
    return { entries: [], error: error instanceof Error ? error : new Error(message) };
  }
}

function getMaxPostsPerRun(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '10', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

async function selectFeedsForRun(env: Env, feeds: FeedConfig[]): Promise<FeedConfig[]> {
  const maxFeedsPerRun = getMaxFeedsPerRun(env.MAX_FEEDS_PER_RUN);
  if (feeds.length <= maxFeedsPerRun) {
    return feeds;
  }

  const cursorKey = 'feed-cursor';
  const rawCursor = await env.SESSION_KV.get(cursorKey);
  const parsedCursor = Number.parseInt(rawCursor ?? '0', 10);
  const cursor =
    Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor % feeds.length : 0;

  const selected: FeedConfig[] = [];
  for (let index = 0; index < maxFeedsPerRun; index += 1) {
    selected.push(feeds[(cursor + index) % feeds.length]);
  }

  const nextCursor = (cursor + maxFeedsPerRun) % feeds.length;
  await env.SESSION_KV.put(cursorKey, String(nextCursor));

  return selected;
}

function getMaxFeedsPerRun(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '5', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function getMaxEntriesPerFeed(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '20', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

export { CLEANUP_CRON, FEED_POLL_CRON };
