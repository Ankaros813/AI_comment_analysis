# External Dynamic Crawler Setup

Vercel functions cannot reliably run browser automation for all targets.
Use a separate Playwright service for dynamic crawling and keep analysis on Vercel.

## Architecture

1. `Vercel` app receives URL and analysis instruction.
2. App crawler runs `auto` mode:
   - direct API / discovered API
   - external dynamic crawler service
   - static fallback
3. External crawler service performs:
   - JavaScript rendering
   - `more` button clicks
   - infinite scroll
   - comment pagination

## Steps

1. Deploy `external_crawler_service` on Railway/Render/Fly.io/Cloud Run/VPS.
2. Confirm `GET /health` returns `{ "ok": true }`.
3. Set Vercel environment variables:
   - `CRAWLER_SERVICE_URL=https://<service-domain>/crawl`
   - `CRAWLER_SERVICE_TOKEN=<token>` (optional, recommended)
4. Redeploy Vercel.

## Notes

- No crawl mode selection is needed in UI now; it is fixed to `auto`.
- This setup is best-effort, not absolute 100%:
  - login-required pages
  - strict anti-bot pages
  - CAPTCHA/interstitial pages
  can still block crawling.
