# google-analytics-search-console-mcp

Two small **MCP servers for Google marketing data**, each a single-file Cloudflare Worker (plain JS, no dependencies).
Both authenticate with a Google **service account** (JWT signed inside the Worker with WebCrypto — no SDK).

| Folder | What it does | Tools |
|---|---|---|
| [`ga4-mcp/`](ga4-mcp) | Google Analytics 4 Data API: traffic, pages, sources, conversions, funnels, realtime, period comparisons | 14 |
| [`search-console-mcp/`](search-console-mcp) | Google Search Console: queries, pages, CTR & keyword opportunities, cannibalization, URL inspection, sitemaps | 20 |

## GA4 tools (14)

| Tool | Description |
|---|---|
| `get_overview` | Overall site performance — sessions, users, pageviews, bounce rate, avg session duration |
| `get_traffic_sources` | Where traffic comes from — organic, direct, social, paid, referral |
| `get_top_pages` | Most visited pages — pageviews, users, avg time on page, bounce rate |
| `get_user_behavior` | How users behave — new vs returning, session duration, pages per session, engagement rate |
| `get_device_breakdown` | Traffic split by device — mobile, desktop, tablet |
| `get_country_breakdown` | Traffic split by country |
| `get_conversions` | Conversion events — purchases, signups, form submits, any goals configured in GA4 |
| `get_landing_pages` | Top landing pages — first page users see, with sessions and bounce rate |
| `get_page_performance` | Detailed performance for a specific page — users, sessions, time on page, exits |
| `compare_periods` | Compare two time periods — spot traffic trends and drops |
| `get_realtime` | Active users on site right now, by page and country |
| `get_funnel_analysis` | Analyze drop-off from landing page to purchase — sessions, add to cart, checkout, purchase rates |
| `get_purchases_by_source` | Purchases & revenue by traffic source — ecommercePurchases, purchaseRevenue, transactions, sessions grouped by source/medium or default channel group, ordered by revenue, with tota |
| `generate_analytics_report` | Full weekly analytics report — overview, traffic sources, top pages, behavior, conversions, recommendations |

## Search Console tools (20)

| Tool | Description |
|---|---|
| `get_site_overview` | Overall clicks, impressions, CTR, position |
| `get_top_pages` | Top pages by clicks |
| `get_top_keywords` | Top search queries |
| `get_keyword_opportunities` | Keywords pos 4-20 with high impressions — easy wins |
| `get_page_keywords` | All keywords for a specific page |
| `compare_periods` | Compare two time periods |
| `get_device_breakdown` | Performance by device — mobile, desktop, tablet |
| `get_country_breakdown` | Performance by country |
| `get_search_type_breakdown` | Performance by search type — web, image, video, news |
| `inspect_url` | Inspect a URL — indexing status, last crawl, canonical, mobile issues |
| `get_sitemaps` | All submitted sitemaps — status, errors, pages submitted vs indexed |
| `get_ctr_opportunities` | Pages with high impressions but low CTR — fix titles to get more clicks |
| `get_trending_keywords` | Keywords that gained or lost most clicks this week vs last week |
| `generate_seo_report` | Full weekly SEO report — overview, wins, issues, recommendations |
| `search_analytics_query` | Flexible Search Analytics query — custom dates, dimensions, filters, search type, paging |
| `get_daily_trend` | Daily clicks, impressions, CTR, position — optionally for one page or one keyword |
| `get_keyword_cannibalization` | Keywords where 2+ of your pages get impressions — possible cannibalization |
| `inspect_urls_batch` | Inspect up to 20 URLs — verdict, coverage, last crawl, canonical match, mobile |
| `submit_sitemap` | Submit (or resubmit) a sitemap to Google Search Console |
| `list_sites` | All GSC properties the service account can access, with permission level |

## Setup

1. Create a Google Cloud service account, enable the **Google Analytics Data API** and **Search Console API**, and download a JSON key.
2. Add the service account email as a *Viewer* in GA4 (Property access management) and as a user in Search Console.
3. Deploy each folder:

```bash
cd ga4-mcp
cp wrangler.toml.example wrangler.toml     # set GA4_PROPERTY_ID
npx wrangler secret put GA4_CLIENT_EMAIL
npx wrangler secret put GA4_PRIVATE_KEY    # the private_key field, with \n escapes
npx wrangler secret put MCP_SECRET
npx wrangler deploy

cd ../search-console-mcp
cp wrangler.toml.example wrangler.toml     # set SITE_URL (e.g. sc-domain:example.com or https://example.com/)
npx wrangler secret put GSC_CLIENT_EMAIL
npx wrangler secret put GSC_PRIVATE_KEY
npx wrangler secret put MCP_SECRET
npx wrangler deploy
```

Env vars — GA4: `GA4_CLIENT_EMAIL`, `GA4_PRIVATE_KEY`, `GA4_PROPERTY_ID`, `MCP_SECRET`; Search Console: `GSC_CLIENT_EMAIL`, `GSC_PRIVATE_KEY`, `MCP_SECRET`, `SITE_URL`.

## Connecting as an MCP server

The worker speaks MCP (JSON-RPC 2.0, protocol `2024-11-05`) over HTTP at `POST /mcp`, protected by
`Authorization: Bearer <MCP_SECRET>`.

Any MCP client that supports remote HTTP servers with custom headers works, e.g.:

```json
{
  "mcpServers": {
    "<worker-name>": {
      "url": "https://<worker-name>.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_SECRET>" }
    }
  }
}
```

For stdio-only clients, bridge it with `npx mcp-remote https://<worker-name>.<your-subdomain>.workers.dev/mcp --header "Authorization: Bearer <MCP_SECRET>"`.

Quick smoke test:

```bash
curl -s https://<worker-name>.<your-subdomain>.workers.dev/mcp \
  -H "Authorization: Bearer $MCP_SECRET" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Example usage

> "Which traffic sources drove purchases last month vs the month before?" → `ga4: compare_periods` / `get_traffic_sources` / `get_conversions`

> "Find keywords ranking 5–15 with high impressions and low CTR." → `gsc: get_keyword_opportunities`, `get_ctr_opportunities`

> "Are two of my pages competing for the same query?" → `gsc: get_keyword_cannibalization`

## License

MIT © Sagi Solomon
