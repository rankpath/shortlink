# Short Link (Mergepdftool)

Short Link is a self-hosted URL shortener with click analytics, QR codes, bulk import, a UTM builder and a REST API.
One Node.js file, no dependencies, no build step. UI follows the Mergepdftool brand book and switches between Thai and English.

ย่อลิงก์บนโดเมนของคุณเอง ดูสถิติคลิก (อุปกรณ์ เบราว์เซอร์ ที่มา ประเทศ) ดาวน์โหลด QR code และเชื่อมต่อผ่าน API
ข้อมูลทั้งหมดเก็บบนเซิร์ฟเวอร์ของคุณ ไม่ส่งไปที่อื่น

## Features

| Feature | Notes |
|---|---|
| Branded short links | Your own domain(s), random 6-character slug or custom alias |
| Click analytics | Clicks per day, unique visitors, device, browser, OS, referrer, country (and city when a CDN sends it), bots counted separately |
| QR codes | Generated in the browser, PNG or SVG, 512–2048 px, navy / royal blue / black |
| Link management | Search, tags, sort, edit destination (dynamic QR keeps working), disable, expiry date, delete, CSV export |
| Bulk add | Paste up to 100 URLs, optional alias and title per line |
| UTM builder | Add utm_source / medium / campaign / content before shortening |
| REST API | Bearer-token API for Make, Zapier, n8n or your own scripts |
| Access control | Admin password for the dashboard, optional public shortening with hourly rate limit |
| Thai / English UI | Auto-detects the browser language, one-tap toggle |

Not included: team accounts with separate logins, A/B split links, geo-routing, city-level data without a CDN header. Everything is single-admin by design.

## Quick start

Requires Node.js 22 or newer.

```bash
cd shortener
cp .env.example .env            # edit ADMIN_PASSWORD and SHORT_DOMAINS
export $(grep -v '^#' .env | xargs)
npm start                       # http://localhost:3000
```

Run the tests (boots a real server on a random port):

```bash
npm test
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Dashboard password. Without it the dashboard and API return 503; existing redirects still work. |
| `SHORT_DOMAINS` (or `BASE_URL`) | recommended | Public origin(s) of your short links, comma separated. First one is the default. Example `https://s.example.com,https://go.example.com`. |
| `API_KEY` | no | Bearer token for the API. Empty = API only via the logged-in dashboard. |
| `TRUST_PROXY` | no | `true` when behind cPanel/Passenger, Nginx, Cloudflare or a load balancer, so client IP and https are read from `X-Forwarded-*`. |
| `PUBLIC_SHORTEN` | no | `true` lets anonymous visitors shorten links (20 per hour per IP). Default `false`. |
| `TZ` | no | Time zone for the daily buckets, e.g. `Asia/Bangkok`. |
| `DATA_DIR` | no | Storage folder. Default `./data`. |
| `PORT`, `HOST` | no | Default `3000`, `0.0.0.0`. |
| `SESSION_SECRET` | no | Cookie signing secret. Defaults to the admin password; set a long random string in production. |

## Storage

On the Node server, two plain files in `DATA_DIR` (on Netlify, the same data lives in Netlify Blobs):

- `links.json` – all links (rewritten atomically on change).
- `clicks.ndjson` – one JSON line per click, appended on every redirect, loaded into memory at start.

Back up by copying the folder. Tens of thousands of clicks are fine; for millions, move to a database.

Each click stores: time, link id, referrer hostname, device/browser/OS (parsed from the user agent), country code (from `CF-IPCountry`, `X-Vercel-IP-Country`, `CloudFront-Viewer-Country` or `X-AppEngine-Country` when present), and a daily hashed visitor id. No raw IP addresses are stored.

## Deploy

### Docker

```bash
docker build -t url-shortener .
docker run -d --name shortener -p 3000:3000 \
  -e ADMIN_PASSWORD=change-me -e API_KEY=your-key \
  -e SHORT_DOMAINS=https://s.example.com -e TRUST_PROXY=true -e TZ=Asia/Bangkok \
  -v shortener-data:/app/data url-shortener
```

Put Nginx, Caddy or Cloudflare in front for TLS and point the short domain at it.

### Namecheap cPanel (Node.js app)

1. Upload the `shortener` folder (server.js, package.json, public/) to e.g. `~/shortener`.
2. cPanel → **Setup Node.js App** → Create application: Node 22, application root `shortener`, startup file `server.js`, application URL = your short domain or subdomain (e.g. `s.yourdomain.com`).
3. Add environment variables: `ADMIN_PASSWORD`, `SHORT_DOMAINS=https://s.yourdomain.com`, `TRUST_PROXY=true`, `API_KEY`, `TZ=Asia/Bangkok`.
4. Start the app. Data is written to `~/shortener/data`.

### Render / Railway / Fly

Deploy the folder as a Node service, start command `npm start`, add the same environment variables, and attach a persistent disk mounted at `DATA_DIR`.

### Netlify (Functions + Blobs)

The same code runs on Netlify: `netlify/functions/app.mjs` serves the API and the redirects, `public/` is the static page, and clicks and links are stored in Netlify Blobs (store `short-link`).

1. In Netlify, **Add new project → Import an existing project**, pick this repo, set **Base directory** to `shortener`. Build command and publish directory come from `netlify.toml`.
2. Add environment variables (scope Functions): `ADMIN_PASSWORD`, `API_KEY`, `SESSION_SECRET`, `SHORT_DOMAINS=https://<your-site>.netlify.app`, `TZ=Asia/Bangkok`.
3. Deploy. Add your own short domain in **Domain management** and append it to `SHORT_DOMAINS`.

Country and city come from Netlify's geo data, so no CDN header setup is needed. Blobs is fine for thousands of clicks; for very high volume, move to Netlify DB.

### Custom domains

Point an `A` (or `CNAME`) record for each short domain at the server, then list every domain in `SHORT_DOMAINS`. Each link can be created on a specific domain; redirects answer on any host the server receives.

## API

All `/api/*` routes accept either the dashboard cookie or `Authorization: Bearer <API_KEY>`. Responses are JSON, CORS is open for API-key use.

| Method & path | Purpose |
|---|---|
| `GET /api/session` | Server configuration and login state (public) |
| `POST /api/login` / `POST /api/logout` | Dashboard session |
| `POST /api/links` | Create: `{ url, slug?, title?, tags?, domain?, expiresAt? }` |
| `POST /api/links/bulk` | Create many: `{ items: [{ url, slug?, title?, tags? }] }` or `{ urls: [...] }`, max 100 |
| `GET /api/links?q=&tag=&sort=created|clicks&limit=&offset=` | List and search |
| `GET /api/links/:idOrSlug` | One link |
| `PATCH /api/links/:id` | Update `{ url?, slug?, title?, tags?, domain?, active?, expiresAt? }` |
| `DELETE /api/links/:id` | Delete link and its clicks |
| `GET /api/links/:id/stats?days=7|30|90` | Timeline, totals, devices, browsers, OS, referrers, countries, recent clicks |
| `GET /api/links/:id/clicks.csv` | Raw click export |
| `GET /api/stats/overview?days=` | Totals across all links plus top links |
| `GET /api/export/links.csv` | All links as CSV |
| `GET /:slug` | 302 redirect (404 unknown, 410 disabled or expired) |

Example:

```bash
curl -X POST https://s.example.com/api/links \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/landing?utm_source=line","slug":"line-oct","tags":["line"]}'
```

Rate limits: 120 API requests per minute per IP, 10 login attempts per 15 minutes, 20 public shortens per hour.

## Brand

Colours and type follow the Mergepdftool brand book: White `#FFFFFF`, Ice `#EFF6FF`, Navy `#061638` for text, Royal Blue `#0057E8` for the single primary button and links, Cyan `#00A6F5` only for the logo and the loading bar, red `#B42318` only for errors. Fonts: Manrope (English) and Noto Sans Thai (Thai, no letter-spacing, line height 1.7).

To change the wordmark or the footer link, edit the `BRAND` object at the top of the script in `public/index.html`.
