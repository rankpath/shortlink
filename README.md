# Short Link

Short Link is a self-hosted URL shortener with click analytics, QR codes, bulk import, a UTM builder and a REST API.
One Node.js file, no dependencies, no build step. UI follows the Short Link brand guide (`brand/short-link-brand-guide.html`) and switches between Thai and English.

ย่อลิงก์บนโดเมนของคุณเอง ดูสถิติคลิก (อุปกรณ์ เบราว์เซอร์ ที่มา ประเทศ) ดาวน์โหลด QR code และเชื่อมต่อผ่าน API
ข้อมูลทั้งหมดเก็บบนเซิร์ฟเวอร์ของคุณ ไม่ส่งไปที่อื่น

## Features

| Feature | Notes |
|---|---|
| Branded short links | Your own domain(s), random 6-character slug or custom alias |
| Click analytics | Clicks per day, unique visitors, device, browser, OS, referrer, country (and city when a CDN sends it), bots counted separately |
| QR codes | Generated in the browser, PNG or SVG, 512–2048 px, deep purple / purple / black |
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

Two plain files in `DATA_DIR` (default `./data`):

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

Put Nginx, Caddy or Cloudflare in front for TLS and point the short domain at it. The `-v` volume keeps `links.json` and `clicks.ndjson` when the container is replaced. Without it, they are lost.

### Namecheap cPanel (Node.js app)

1. Upload `server.js`, `package.json`, `lib/` and `public/` to e.g. `~/shortlink`. The Node server does not use any npm package, so you do not need to run npm install.
2. cPanel → **Setup Node.js App** → Create application: Node 22 or newer (if your cPanel offers it), application root `shortlink`, startup file `server.js`, application URL = your short domain or subdomain (e.g. `s.yourdomain.com`).
3. Add environment variables: `ADMIN_PASSWORD`, `SHORT_DOMAINS=https://s.yourdomain.com`, `TRUST_PROXY=true`, `API_KEY`, `TZ=Asia/Bangkok`.
4. Start the app. Data is written to `~/shortlink/data`.

### Render

1. **New → Web Service**, connect this repo, branch `main`.
2. Runtime **Docker** uses the `Dockerfile`. Runtime **Node** works too: build command `npm install`, start command `npm start`.
3. Add a persistent disk (paid instances only). With Docker, mount it at `/app/data`. With the Node runtime, mount it at e.g. `/var/data` and also set `DATA_DIR=/var/data`; without `DATA_DIR` the app writes inside the code folder, which is wiped on every deploy.
4. Environment variables: `ADMIN_PASSWORD`, `API_KEY`, `SESSION_SECRET`, `SHORT_DOMAINS=https://<your-service>.onrender.com` (add your own domain later), `TRUST_PROXY=true`, `TZ=Asia/Bangkok`.
5. Deploy, then check the log line `listening on … · N links loaded · data in <folder>`. The folder must be the disk path.

Without a disk (for example on a free instance), links and clicks are lost on every deploy or restart.

### Railway / Fly (Docker)

Deploy from the `Dockerfile`, add the same environment variables, and attach a persistent volume at `/app/data` (or mount it elsewhere and set `DATA_DIR` to that path). Set `TRUST_PROXY=true` so client IPs and https come from the platform proxy. Fly.io also needs its own `fly.toml`, which this repo does not include.

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

Colours and type follow the Short Link brand guide (`brand/short-link-brand-guide.html`). Deep Purple `#2D0B5B` is the logo colour, Pink `#FF4D8D` is for the main button and charts (with Navy Ink text, never white), Purple `#7C3AED` is for links and icons, Blush `#FFE8F0` is for surfaces, Navy Ink `#170528` is for text, and red `#B42318` is for errors only. Fonts: Manrope (English) and Noto Sans Thai (Thai, no letter-spacing, line height 1.7).

The logo files are in `public/brand/`. To change the footer credit or its link, edit the `BRAND` object at the top of the script in `public/index.html`.
