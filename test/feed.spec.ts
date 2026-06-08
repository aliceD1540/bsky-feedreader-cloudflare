import { describe, expect, it } from 'vitest';
import { parseFeedXml } from '../src/feed';

describe('parseFeedXml', () => {
  it('parses RSS/RDF feeds', () => {
    const xml = `<?xml version="1.0"?>
      <rdf:RDF
        xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
        xmlns="http://purl.org/rss/1.0/"
        xmlns:media="http://search.yahoo.com/mrss/">
        <channel rdf:about="https://example.com/feed.rdf">
          <title>Example RSS</title>
        </channel>
        <item rdf:about="https://example.com/posts/1">
          <title>First post</title>
          <link>https://example.com/posts/1</link>
          <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">2026-06-01T12:00:00Z</dc:date>
          <media:thumbnail url="https://example.com/thumb.jpg" />
        </item>
      </rdf:RDF>`;

    const entries = parseFeedXml(xml, {
      title: 'RSS Feed',
      url: 'https://example.com/feed.rdf',
    });

    expect(entries).toEqual([
      {
        feedTitle: 'RSS Feed',
        feedUrl: 'https://example.com/feed.rdf',
        title: 'First post',
        entryUrl: 'https://example.com/posts/1',
        publishedAt: '2026-06-01T12:00:00.000Z',
        thumbnailUrl: 'https://example.com/thumb.jpg',
      },
    ]);
  });

  it('parses Atom feeds', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Example Atom</title>
        <entry>
          <title>Atom post</title>
          <link rel="alternate" href="/posts/atom-1" />
          <updated>2026-06-02T00:00:00Z</updated>
          <link rel="enclosure" href="https://example.com/thumb.png" type="image/png" />
        </entry>
      </feed>`;

    const entries = parseFeedXml(xml, {
      title: 'Atom Feed',
      url: 'https://example.com/atom.xml',
    });

    expect(entries).toEqual([
      {
        feedTitle: 'Atom Feed',
        feedUrl: 'https://example.com/atom.xml',
        title: 'Atom post',
        entryUrl: 'https://example.com/posts/atom-1',
        publishedAt: '2026-06-02T00:00:00.000Z',
        thumbnailUrl: 'https://example.com/thumb.png',
      },
    ]);
  });

  it('keeps only the latest N entries when maxEntries is specified', () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Example RSS</title>
          <item>
            <title>Old</title>
            <link>https://example.com/posts/old</link>
            <pubDate>Tue, 01 Jun 2026 00:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Middle</title>
            <link>https://example.com/posts/middle</link>
            <pubDate>Wed, 02 Jun 2026 00:00:00 GMT</pubDate>
          </item>
          <item>
            <title>New</title>
            <link>https://example.com/posts/new</link>
            <pubDate>Thu, 03 Jun 2026 00:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>`;

    const entries = parseFeedXml(
      xml,
      {
        title: 'RSS Feed',
        url: 'https://example.com/feed.rdf',
      },
      2,
    );

    expect(entries.map((entry) => entry.entryUrl)).toEqual([
      'https://example.com/posts/middle',
      'https://example.com/posts/new',
    ]);
  });
});
