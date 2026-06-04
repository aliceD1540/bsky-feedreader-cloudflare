# Bluesky FeedReader on Cloudflare

Cloudflare Workers 上で RSS/Atom フィードを巡回し、新着エントリーを Bluesky に投稿する Bot です。

## 動作概要

1. Cron Trigger で Worker が起動
2. `FEED_CONFIG_URL` から購読対象フィード一覧 JSON を取得
3. 各フィードを取得して RSS/RDF/Atom を解析
4. D1 で未投稿エントリーだけを claim
5. Bluesky に投稿
6. 投稿済みエントリーを D1 に記録

## 必要な Cloudflare リソース

- Worker
- D1 Database
- KV Namespace

## セットアップ

1. 依存関係をインストールします。
   ```bash
   npm install
   ```
2. D1 と KV を作成し、`wrangler.jsonc` の ID を更新します。
   ```bash
   npx wrangler d1 create bsky-feedreader-cloudflare
   npx wrangler kv namespace create SESSION_KV
   ```
3. D1 マイグレーションを適用します。
   ```bash
   npx wrangler d1 migrations apply bsky-feedreader-cloudflare --local
   npx wrangler d1 migrations apply bsky-feedreader-cloudflare --remote
   ```
4. Bluesky 認証情報を secret として設定します。
   ```bash
   npx wrangler secret put BSKY_USERNAME
   npx wrangler secret put BSKY_APP_PASSWORD
   ```
5. 型定義を再生成します。
   ```bash
   npm run cf-typegen
   ```

## フィード設定 JSON

`FEED_CONFIG_URL` は次の JSON を返す必要があります。

```json
{
  "check_feeds": [
    {
      "title": "AKIBA PC Hotline!",
      "url": "https://akiba-pc.watch.impress.co.jp/data/rss/1.0/ah/feed.rdf"
    },
    {
      "title": "INTERNET Watch",
      "url": "https://internet.watch.impress.co.jp/data/rss/1.0/iw/feed.rdf"
    }
  ]
}
```

## 開発コマンド

```bash
npm run dev
npm run typecheck
npm run test
```

`npm run dev` 実行中は `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` で scheduled handler を確認できます。
