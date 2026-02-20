# External Crawler Service (Playwright)

This service handles dynamic comment crawling that cannot run directly inside Vercel functions.

It supports:
- JavaScript-rendered comment sections
- Repeated `more` / `load more` clicks
- Infinite-scroll style loading
- Next-page navigation for comment pages
- List -> post traversal mode

## API

- `GET /health`
- `POST /crawl`

Request body:

```json
{
  "sourceUrl": "https://example.com/post/123",
  "collectionMode": "single_page",
  "maxPages": 8,
  "maxPosts": 40,
  "maxCommentPagesPerPost": 3,
  "selectors": {
    "comment": ".comment, .reply",
    "author": ".author",
    "datetime": "time, .date",
    "next": "a[rel='next'], .next a",
    "postLink": "a[href*='/article/']",
    "listNext": ".pagination .next",
    "commentNext": ".comment-pager .next"
  }
}
```

Response body:

```json
{
  "ok": true,
  "pagesScanned": 12,
  "rawCount": 380,
  "notes": "single_page pages=8 raw=380 unique=112",
  "comments": [
    {
      "external_id": "abc123",
      "parent_external_id": null,
      "content": "comment text",
      "author": "user1",
      "datetime": "2026-02-20 10:10:10",
      "published_at": "2026-02-20 10:10:10",
      "comment_url": "https://example.com/post/123",
      "status": "active"
    }
  ]
}
```

## Local Run

```bash
cd external_crawler_service
npm install
npx playwright install chromium
npm run start
```

Default port is `8080`.

## Environment Variables

- `PORT` default: `8080`
- `CRAWLER_SERVICE_TOKEN` optional shared token
- `NAV_TIMEOUT_MS` default: `30000`
- `MAX_INTERACTION_PASSES` default: `8`
- `INTERACTION_DELAY_MS` default: `700`

If `CRAWLER_SERVICE_TOKEN` is set, requests must include:

- header: `x-crawler-token: <same-token>`

## Connect From Vercel App

Set these variables in your Vercel project:

- `CRAWLER_SERVICE_URL=https://<your-service-domain>/crawl`
- `CRAWLER_SERVICE_TOKEN=<same-token>` (optional)

The app then runs:
- API/auto discovery first
- external crawler fallback next
- static fallback last
