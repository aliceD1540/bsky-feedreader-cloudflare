# Bluesky FeedReader on Cloudflare

## 概要

RSS/Atomフィードを購読して、Blueskyに投稿するBotのCloudflare版です。

## 動作環境

CloudflareのPages, Worker, KV, D1

## 処理の流れ

1. Workerが定期的に起動する
2. envに設定したURLから購読対象フィード一覧のJSONを取得する
3. フィードを取得して、更新されたエントリーを抽出する
4. D1に保存されている投稿済みのエントリーと比較して、未投稿のエントリーを特定する
5. 未投稿のエントリーをBlueskyに投稿する
6. 投稿したエントリーのURLをD1に保存する

### フィードのJSON形式

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