// Short Link by Mergepdftool — self-hosted URL shortener, zero dependencies.
// Node.js 22 or newer. Run with: ADMIN_PASSWORD=... node server.js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShortener, parseDomains, countryFromHeaders, cityFromHeaders, CSP } from './lib/core.js';
import { createFileStore } from './lib/file-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const trustProxy = process.env.TRUST_PROXY === 'true';
const config = {
  adminPassword: process.env.ADMIN_PASSWORD || '',
  apiKey: process.env.API_KEY || '',
  publicShorten: process.env.PUBLIC_SHORTEN === 'true',
  trustProxy,
  sessionSecret: process.env.SESSION_SECRET || '',
  domains: parseDomains(process.env.SHORT_DOMAINS || process.env.BASE_URL)
};
const dataDir = process.env.DATA_DIR || join(here, 'data');
const store = await createFileStore(dataDir);
const app = createShortener({ config, store });

const staticCache = new Map();
async function staticFile(name) {
  if (process.env.NODE_ENV === 'production' && staticCache.has(name)) return staticCache.get(name);
  const body = await readFile(join(publicDir, name)); staticCache.set(name, body); return body;
}
function clientIp(req) {
  if (trustProxy) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return req.socket.remoteAddress || 'unknown';
}
async function toRequest(req) {
  const proto = trustProxy ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() : 'http';
  const hostHeader = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${port}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const chunks = []; for await (const chunk of req) { chunks.push(chunk); if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) throw new Error('Request body too large'); }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`${proto}://${hostHeader}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}
async function send(res, response) {
  const headers = {}; response.headers.forEach((v, k) => { headers[k] = v; });
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers); res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP });
      return res.end(await staticFile('index.html'));
    }
    if (url.pathname === '/qr.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' }); return res.end(await staticFile('qr.js')); }
    if (/^\/brand\/[a-z0-9-]+\.png$/.test(url.pathname)) {
      try {
        const body = await readFile(join(publicDir, url.pathname));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }
    const request = await toRequest(req);
    const get = (name) => req.headers[name];
    const result = await app.handle(request, { ip: clientIp(req), country: countryFromHeaders(get), city: cityFromHeaders(get) });
    const response = result instanceof Response ? result : result.response;
    await send(res, response);
    if (result.pending) await result.pending;
  } catch (err) {
    console.error('[short-link]', err);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Internal server error.' })); } else res.end();
  }
});

async function shutdown(signal) {
  console.log(`[short-link] ${signal} received, flushing data…`);
  await store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
if (!config.adminPassword) console.warn('[short-link] ADMIN_PASSWORD is not set: the dashboard and API are disabled until you set it. Redirects still work.');
if (!config.domains.length) console.warn('[short-link] BASE_URL/SHORT_DOMAINS not set: short links will use the request host.');
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
server.listen(port, host, () => console.log(`[short-link] listening on http://${host}:${port} · ${store.size()} links loaded · data in ${dataDir}`));
