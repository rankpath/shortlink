// Short Link core: request handling shared by the Node server (server.js) and the Netlify function.
// Uses web-standard Request/Response. Storage is injected (file store or Netlify Blobs).
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const RESERVED = new Set(['api', 'health', 'index.html', 'qr.js', 'favicon.ico', 'favicon.svg', 'robots.txt', 'admin', 'login', 'logout', 'static', 'assets', 'dashboard', 'app', '_headers', 'netlify']);
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const MAX_URL = 2048;
const MAX_BULK = 100;
const COOKIE = 'shortener_session';
const SESSION_DAYS = 30;

export const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#F64B72"/><g fill="none" stroke="#FCE4EC" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 27v-7h7"/><path d="M37 20h7v7"/><path d="M44 37v7h-7"/><path d="M27 44h-7v-7"/></g></svg>';
export const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; base-uri 'self'; form-action 'self'";

export function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).origin; } catch { return null; }
}
export function parseDomains(value) { return String(value || '').split(',').map(normalizeOrigin).filter(Boolean); }
const sha256 = (v) => createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => timingSafeEqual(sha256(a), sha256(b));
function dateKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function escapeHtml(v) { return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function topList(map, limit = 8) { return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit); }

export function statusPage(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="icon" href="/favicon.svg"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=Noto+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet"><style>body{margin:0;font-family:Manrope,"Noto Sans Thai",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#fff;color:#061E45;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}main{max-width:420px;text-align:center}h1{font-size:28px;margin:0 0 8px}p{color:#5B6B8C;line-height:1.7;margin:0 0 20px}a{display:inline-block;background:#D01170;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="/">Go to the home page</a></main></body></html>`;
}

// ---------- user agent / referrer parsing ----------
export function parseAgent(ua) {
  const s = String(ua || '');
  if (!s) return { dev: 'unknown', br: 'Unknown', os: 'Unknown' };
  if (/bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|discordbot|twitterbot|linkedinbot|skypeuripreview|preview|curl\/|wget\/|python-requests|headless|lighthouse|pingdom|uptime/i.test(s)) return { dev: 'bot', br: 'Bot', os: 'Bot' };
  const dev = /iPad|Tablet|PlayBook|Silk|Kindle|(?:Android(?!.*Mobile))/i.test(s) ? 'tablet' : /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry|Opera Mini/i.test(s) ? 'mobile' : 'desktop';
  let br = 'Other';
  if (/Edg(?:e|A|iOS)?\//i.test(s)) br = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) br = 'Opera';
  else if (/SamsungBrowser/i.test(s)) br = 'Samsung Internet';
  else if (/\bLine\//i.test(s)) br = 'LINE';
  else if (/FBAN|FBAV|FB_IAB/i.test(s)) br = 'Facebook';
  else if (/Instagram/i.test(s)) br = 'Instagram';
  else if (/TikTok|BytedanceWebview|musical_ly/i.test(s)) br = 'TikTok';
  else if (/Chrome\/|CriOS\//i.test(s)) br = 'Chrome';
  else if (/Firefox\/|FxiOS\//i.test(s)) br = 'Firefox';
  else if (/Safari\//i.test(s)) br = 'Safari';
  else if (/MSIE|Trident\//i.test(s)) br = 'Internet Explorer';
  let os = 'Other';
  if (/Windows/i.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Linux/i.test(s)) os = 'Linux';
  return { dev, br, os };
}
function referrerHost(ref) {
  if (!ref) return 'direct';
  try { const u = new URL(ref); return (u.hostname || u.protocol.replace(':', '')).replace(/^www\./, '').toLowerCase() || 'direct'; } catch { return 'other'; }
}

/**
 * createShortener({ config, store })
 * config: { adminPassword, apiKey, publicShorten, domains: [origin], sessionSecret, trustProxy }
 * store:  { getLinks(), putLinks(links), getClicks(id), getAllClicks() -> Map, appendClick(id, click), deleteClicks(id) }
 * Returns { handle(request, info) } where info = { ip, country, city } (all optional).
 */
export function createShortener({ config, store }) {
  const cfg = { adminPassword: '', apiKey: '', publicShorten: false, domains: [], trustProxy: false, ...config };
  cfg.sessionSecret = cfg.sessionSecret || cfg.adminPassword || randomBytes(32).toString('hex');

  // Rate limiting: fixed window, in memory (best effort; per instance).
  const buckets = new Map();
  function rateLimited(key, limit, windowMs) {
    const now = Date.now();
    if (buckets.size > 20_000) for (const [k, b] of buckets) if (now - b.start >= b.window) buckets.delete(k);
    const b = buckets.get(key);
    if (!b || now - b.start >= windowMs) { buckets.set(key, { start: now, count: 1, window: windowMs }); return 0; }
    b.count += 1;
    return b.count > limit ? Math.ceil((b.start + windowMs - now) / 1000) : 0;
  }

  const json = (status, payload, headers = {}) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
  const html = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP } });
  const text = (status, body, type, headers = {}) => new Response(body, { status, headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers } });

  function requestOrigin(req) {
    const url = new URL(req.url);
    if (cfg.trustProxy) {
      const proto = String(req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
      const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
      return `${proto}://${host}`;
    }
    return url.origin;
  }
  const defaultOrigin = (req) => cfg.domains[0] || requestOrigin(req);
  const isSecure = (req) => requestOrigin(req).startsWith('https://');

  // ---------- sessions ----------
  const signSession = (exp) => createHmac('sha256', cfg.sessionSecret).update(`session:${exp}`).digest('hex');
  function sessionCookie(req) { const exp = Date.now() + SESSION_DAYS * 86_400_000; return `${COOKIE}=${exp}.${signSession(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${isSecure(req) ? '; Secure' : ''}`; }
  const clearCookie = (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`;
  function hasValidSession(req) {
    const match = String(req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!match) return false;
    const [exp, sig] = match[1].split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    return safeEqual(sig, signSession(exp));
  }
  function hasValidApiKey(req) {
    if (!cfg.apiKey) return false;
    const header = String(req.headers.get('authorization') || '');
    return header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), cfg.apiKey);
  }
  const isAuthenticated = (req) => Boolean(cfg.adminPassword) && (hasValidSession(req) || hasValidApiKey(req));

  // ---------- validation ----------
  const newId = () => randomBytes(6).toString('base64url');
  const randomSlug = (n) => { let s = ''; for (let i = 0; i < n; i += 1) s += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)]; return s; };
  function uniqueSlug(links) {
    const taken = new Set(links.map((l) => l.slug));
    for (let length = 6; length < 12; length += 1) for (let a = 0; a < 5; a += 1) { const slug = randomSlug(length); if (!taken.has(slug) && !RESERVED.has(slug)) return slug; }
    throw new Error('Could not allocate a slug');
  }
  function validateUrl(input) {
    if (typeof input !== 'string' || !input.trim()) return { error: 'Destination URL is required.' };
    let raw = input.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
    if (raw.length > MAX_URL) return { error: `URL is too long (max ${MAX_URL} characters).` };
    let parsed;
    try { parsed = new URL(raw); } catch { return { error: 'That does not look like a valid URL.' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'Only http and https links can be shortened.' };
    if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) return { error: 'URL needs a valid hostname.' };
    if (parsed.username || parsed.password) return { error: 'URLs with embedded credentials are not allowed.' };
    if (cfg.domains.some((d) => new URL(d).host === parsed.host)) return { error: 'You cannot shorten a link that points to this shortener.' };
    return { url: parsed.href };
  }
  function validateSlug(input, links, currentId = null) {
    if (input == null || input === '') return { slug: null };
    const slug = String(input).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) return { error: 'Alias may use letters, numbers, dashes and underscores (1–64 characters).' };
    if (RESERVED.has(slug)) return { error: 'That alias is reserved.' };
    const existing = links.find((l) => l.slug === slug);
    if (existing && existing.id !== currentId) return { error: 'That alias is already taken.' };
    return { slug };
  }
  function validateTags(input) {
    const list = Array.isArray(input) ? input : String(input || '').split(',');
    const tags = [];
    for (const raw of list) { const tag = String(raw).trim().slice(0, 32); if (tag && !tags.includes(tag)) tags.push(tag); if (tags.length >= 10) break; }
    return tags;
  }
  const validateTitle = (v) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');
  function validateDomain(input) {
    if (input == null || input === '') return { domain: null };
    const origin = normalizeOrigin(input);
    if (!origin || !cfg.domains.includes(origin)) return { error: 'That domain is not configured on this server (see SHORT_DOMAINS).' };
    return { domain: origin };
  }
  function validateExpiry(input) {
    if (input == null || input === '') return { expiresAt: null };
    const t = Date.parse(input);
    if (Number.isNaN(t)) return { error: 'Expiry must be a valid date/time.' };
    return { expiresAt: new Date(t).toISOString() };
  }
  function serialize(link, req, clicks) {
    const expired = Boolean(link.expiresAt && Date.parse(link.expiresAt) <= Date.now());
    const counts = countClicks(clicks || []);
    return { ...link, ...counts, shortUrl: `${link.domain || defaultOrigin(req)}/${link.slug}`, expired, status: !link.active ? 'disabled' : expired ? 'expired' : 'active' };
  }
  function countClicks(clicks) {
    let human = 0, bots = 0;
    for (const c of clicks) { if (c.dev === 'bot') bots += 1; else human += 1; }
    return { clicks: human, botClicks: bots, lastClickAt: clicks.length ? clicks[clicks.length - 1].t : null };
  }
  function buildLink(body, links, anonymous) {
    const url = validateUrl(body.url ?? body.originalURL ?? body.destination); if (url.error) return { error: url.error };
    const slug = validateSlug(body.slug ?? body.alias ?? body.path, links); if (slug.error) return { error: slug.error };
    const domain = validateDomain(body.domain); if (domain.error) return { error: domain.error };
    const expiry = validateExpiry(body.expiresAt); if (expiry.error) return { error: expiry.error };
    const now = new Date().toISOString();
    return { link: { id: newId(), slug: slug.slug || uniqueSlug(links), url: url.url, title: validateTitle(body.title), tags: validateTags(body.tags), domain: domain.domain, createdAt: now, updatedAt: now, expiresAt: expiry.expiresAt, active: true, createdBy: anonymous ? 'public' : 'admin' } };
  }

  // ---------- statistics ----------
  const windowDays = (url) => { const n = Number(url.searchParams.get('days') || 30); return [7, 14, 30, 90].includes(n) ? n : 30; };
  function aggregate(clickLists, days) {
    const now = Date.now(), todayStart = startOfDay(now), windowStart = todayStart - (days - 1) * 86_400_000;
    const timeline = new Map();
    for (let i = days - 1; i >= 0; i -= 1) { const key = dateKey(todayStart - i * 86_400_000); timeline.set(key, { date: key, clicks: 0, visitors: new Set() }); }
    const tally = { devices: new Map(), browsers: new Map(), os: new Map(), referrers: new Map(), countries: new Map() };
    const visitors = new Set();
    const totals = { clicks: 0, bots: 0, today: 0, window: 0 };
    for (const list of clickLists) for (const c of list) {
      if (c.dev === 'bot') { totals.bots += 1; continue; }
      totals.clicks += 1;
      const t = Date.parse(c.t);
      if (t >= todayStart) totals.today += 1;
      if (t < windowStart) continue;
      totals.window += 1; visitors.add(c.v);
      const bucket = timeline.get(dateKey(t)); if (bucket) { bucket.clicks += 1; bucket.visitors.add(c.v); }
      for (const [k, v] of [['devices', c.dev], ['browsers', c.br], ['os', c.os], ['referrers', c.ref], ['countries', c.cc]]) tally[k].set(v, (tally[k].get(v) || 0) + 1);
    }
    return { days, totals: { ...totals, visitors: visitors.size }, timeline: [...timeline.values()].map((d) => ({ date: d.date, clicks: d.clicks, visitors: d.visitors.size })), devices: topList(tally.devices), browsers: topList(tally.browsers), os: topList(tally.os), referrers: topList(tally.referrers), countries: topList(tally.countries) };
  }

  async function readJson(req, limit = 1_000_000) {
    const body = await req.text();
    if (body.length > limit) throw new Error('too large');
    return body ? JSON.parse(body) : {};
  }

  // ---------- API ----------
  async function api(req, url, info) {
    const path = url.pathname;
    const ip = info.ip || 'unknown';
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const retry = rateLimited(`api:${ip}`, 120, 60_000);
    if (retry) return json(429, { error: 'Too many requests. Try again shortly.' }, { ...cors, 'Retry-After': String(retry) });
    const authed = isAuthenticated(req);

    if (path === '/api/session' && req.method === 'GET') return json(200, { configured: Boolean(cfg.adminPassword), authenticated: authed, publicShorten: cfg.publicShorten, apiEnabled: Boolean(cfg.apiKey), domains: cfg.domains, defaultDomain: defaultOrigin(req), version: '1.1.0' }, cors);
    if (!cfg.adminPassword) return json(503, { error: 'ADMIN_PASSWORD is not set on the server. Set it and restart.' }, cors);
    if (path === '/api/login' && req.method === 'POST') {
      const wait = rateLimited(`login:${ip}`, 10, 15 * 60_000);
      if (wait) return json(429, { error: 'Too many login attempts. Wait a few minutes.' }, { ...cors, 'Retry-After': String(wait) });
      let body; try { body = await readJson(req, 10_000); } catch { return json(400, { error: 'Invalid JSON.' }, cors); }
      if (typeof body.password !== 'string' || !safeEqual(body.password, cfg.adminPassword)) return json(401, { error: 'Wrong password.' }, cors);
      return json(200, { ok: true }, { ...cors, 'Set-Cookie': sessionCookie(req) });
    }
    if (path === '/api/logout' && req.method === 'POST') return json(200, { ok: true }, { ...cors, 'Set-Cookie': clearCookie(req) });

    if (path === '/api/links' && req.method === 'POST') {
      const anonymous = !authed;
      if (anonymous) {
        if (!cfg.publicShorten) return json(401, { error: 'Login required.' }, cors);
        const wait = rateLimited(`public:${ip}`, 20, 60 * 60_000);
        if (wait) return json(429, { error: 'Hourly limit reached. Try again later.' }, { ...cors, 'Retry-After': String(wait) });
      }
      let body; try { body = await readJson(req, 20_000); } catch { return json(400, { error: 'Invalid JSON.' }, cors); }
      const links = await store.getLinks();
      const built = buildLink(body, links, anonymous);
      if (built.error) return json(400, { error: built.error }, cors);
      links.push(built.link); await store.putLinks(links);
      return json(201, { link: serialize(built.link, req, []) }, cors);
    }
    if (!authed) return json(401, { error: 'Login required.' }, cors);

    if (path === '/api/links' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const tag = (url.searchParams.get('tag') || '').trim();
      const sort = url.searchParams.get('sort') || 'created';
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const links = await store.getLinks(); const all = await store.getAllClicks();
      let list = links.map((l) => serialize(l, req, all.get(l.id)));
      if (q) list = list.filter((l) => l.slug.includes(q) || l.url.toLowerCase().includes(q) || l.title.toLowerCase().includes(q) || l.tags.some((t) => t.toLowerCase().includes(q)));
      if (tag) list = list.filter((l) => l.tags.includes(tag));
      list.sort((a, b) => sort === 'clicks' ? b.clicks - a.clicks || b.createdAt.localeCompare(a.createdAt) : b.createdAt.localeCompare(a.createdAt));
      const tags = new Map(); for (const l of links) for (const t of l.tags) tags.set(t, (tags.get(t) || 0) + 1);
      return json(200, { total: list.length, offset, limit, links: list.slice(offset, offset + limit), tags: topList(tags, 50) }, cors);
    }
    if (path === '/api/links/bulk' && req.method === 'POST') {
      let body; try { body = await readJson(req); } catch { return json(400, { error: 'Invalid JSON.' }, cors); }
      const items = Array.isArray(body.items) ? body.items : Array.isArray(body.urls) ? body.urls.map((u) => ({ url: u })) : null;
      if (!items || !items.length) return json(400, { error: 'Send { items: [{ url, slug?, title?, tags? }] } or { urls: [...] }.' }, cors);
      if (items.length > MAX_BULK) return json(400, { error: `Bulk create is limited to ${MAX_BULK} links per request.` }, cors);
      const links = await store.getLinks(); const created = [], errors = [];
      items.forEach((item, index) => {
        const built = buildLink(typeof item === 'string' ? { url: item } : (item || {}), links, false);
        if (built.error) errors.push({ index, input: item, error: built.error });
        else { links.push(built.link); created.push(serialize(built.link, req, [])); }
      });
      if (created.length) await store.putLinks(links);
      return json(200, { created, errors }, cors);
    }
    if (path === '/api/stats/overview' && req.method === 'GET') {
      const days = windowDays(url);
      const links = await store.getLinks(); const all = await store.getAllClicks();
      const stats = aggregate([...all.values()], days);
      const windowStart = startOfDay(Date.now()) - (days - 1) * 86_400_000;
      const topLinks = links.map((l) => {
        const list = all.get(l.id) || [];
        return { ...serialize(l, req, list), windowClicks: list.reduce((n, c) => n + (c.dev !== 'bot' && Date.parse(c.t) >= windowStart ? 1 : 0), 0) };
      }).filter((l) => l.windowClicks > 0).sort((a, b) => b.windowClicks - a.windowClicks).slice(0, 5);
      return json(200, { ...stats, totals: { ...stats.totals, links: links.length }, topLinks }, cors);
    }
    if (path === '/api/export/links.csv' && req.method === 'GET') {
      const links = await store.getLinks(); const all = await store.getAllClicks();
      const rows = [['id', 'slug', 'short_url', 'destination', 'title', 'tags', 'clicks', 'bot_clicks', 'status', 'created_at', 'last_click_at']];
      for (const l of links) { const s = serialize(l, req, all.get(l.id)); rows.push([s.id, s.slug, s.shortUrl, s.url, s.title, s.tags.join('|'), s.clicks, s.botClicks, s.status, s.createdAt, s.lastClickAt || '']); }
      return text(200, rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv; charset=utf-8', { ...cors, 'Content-Disposition': 'attachment; filename="links.csv"' });
    }

    const match = path.match(/^\/api\/links\/([A-Za-z0-9_-]+)(?:\/(stats|clicks\.csv))?$/);
    if (!match) return json(404, { error: 'Not found.' }, cors);
    const links = await store.getLinks();
    const link = links.find((l) => l.id === match[1]) || links.find((l) => l.slug === match[1].toLowerCase());
    if (!link) return json(404, { error: 'Link not found.' }, cors);
    const sub = match[2];
    if (sub === 'stats' && req.method === 'GET') {
      const clicks = await store.getClicks(link.id);
      const recent = clicks.slice(-25).reverse().map((c) => ({ t: c.t, ref: c.ref, dev: c.dev, br: c.br, os: c.os, cc: c.cc, city: c.city }));
      return json(200, { link: serialize(link, req, clicks), ...aggregate([clicks], windowDays(url)), recent }, cors);
    }
    if (sub === 'clicks.csv' && req.method === 'GET') {
      const rows = [['time', 'country', 'city', 'device', 'browser', 'os', 'referrer', 'visitor']];
      for (const c of await store.getClicks(link.id)) rows.push([c.t, c.cc, c.city, c.dev, c.br, c.os, c.ref, c.v]);
      return text(200, rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv; charset=utf-8', { ...cors, 'Content-Disposition': `attachment; filename="clicks-${link.slug}.csv"` });
    }
    if (sub) return json(405, { error: 'Method not allowed.' }, cors);
    if (req.method === 'GET') return json(200, { link: serialize(link, req, await store.getClicks(link.id)) }, cors);
    if (req.method === 'PATCH') {
      let body; try { body = await readJson(req, 20_000); } catch { return json(400, { error: 'Invalid JSON.' }, cors); }
      const patch = {};
      if (body.url !== undefined) { const r = validateUrl(body.url); if (r.error) return json(400, { error: r.error }, cors); patch.url = r.url; }
      if (body.slug !== undefined) { const r = validateSlug(body.slug, links, link.id); if (r.error) return json(400, { error: r.error }, cors); if (r.slug) patch.slug = r.slug; }
      if (body.domain !== undefined) { const r = validateDomain(body.domain); if (r.error) return json(400, { error: r.error }, cors); patch.domain = r.domain; }
      if (body.expiresAt !== undefined) { const r = validateExpiry(body.expiresAt); if (r.error) return json(400, { error: r.error }, cors); patch.expiresAt = r.expiresAt; }
      if (body.title !== undefined) patch.title = validateTitle(body.title);
      if (body.tags !== undefined) patch.tags = validateTags(body.tags);
      if (body.active !== undefined) patch.active = Boolean(body.active);
      Object.assign(link, patch, { updatedAt: new Date().toISOString() });
      await store.putLinks(links);
      return json(200, { link: serialize(link, req, await store.getClicks(link.id)) }, cors);
    }
    if (req.method === 'DELETE') {
      await store.putLinks(links.filter((l) => l.id !== link.id));
      await store.deleteClicks(link.id);
      return new Response(null, { status: 204, headers: cors });
    }
    return json(405, { error: 'Method not allowed.' }, cors);
  }

  // ---------- redirect ----------
  async function redirect(req, slug, info) {
    const links = await store.getLinks();
    const link = links.find((l) => l.slug === slug);
    if (!link) return html(404, statusPage('Link not found', 'This short link does not exist or was removed.'));
    if (!link.active) return html(410, statusPage('Link disabled', 'The owner has turned this link off.'));
    if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) return html(410, statusPage('Link expired', 'This short link is no longer active.'));
    let pending = null;
    if (req.method === 'GET') {
      const ua = req.headers.get('user-agent');
      const agent = parseAgent(ua);
      const visitor = createHmac('sha256', cfg.sessionSecret).update(`${info.ip || ''}|${ua || ''}|${dateKey(Date.now())}`).digest('hex').slice(0, 16);
      const cc = String(info.country || '').toUpperCase();
      const click = { t: new Date().toISOString(), id: link.id, ref: referrerHost(req.headers.get('referer')), dev: agent.dev, br: agent.br, os: agent.os, cc: /^[A-Z]{2}$/.test(cc) ? cc : 'XX', city: String(info.city || '').slice(0, 64), v: visitor };
      pending = store.appendClick(link.id, click);
    }
    const res = new Response(null, { status: 302, headers: { Location: link.url, 'Cache-Control': 'no-store, max-age=0', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Robots-Tag': 'noindex' } });
    return pending ? { response: res, pending } : res;
  }

  async function handle(req, info = {}) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/health') return json(200, { ok: true, service: 'short-link' });
    if (path === '/favicon.svg') return text(200, FAVICON, 'image/svg+xml', { 'Cache-Control': 'public, max-age=86400' });
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/robots.txt') return text(200, 'User-agent: *\nDisallow: /api/\n', 'text/plain; charset=utf-8');
    if (path.startsWith('/api/')) return api(req, url, info);
    const match = path.match(/^\/([A-Za-z0-9_-]{1,64})\/?$/);
    if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return html(404, statusPage('Link not found', 'This short link does not exist or was removed.'));
    return redirect(req, match[1].toLowerCase(), info);
  }

  return { handle, html };
}

// Helpers for server-side country headers (Cloudflare, Vercel, CloudFront, App Engine) used by the Node server.
export function countryFromHeaders(get) {
  const cc = String(get('cf-ipcountry') || get('x-vercel-ip-country') || get('cloudfront-viewer-country') || get('x-appengine-country') || get('x-country-code') || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? cc : 'XX';
}
export function cityFromHeaders(get) {
  try { return decodeURIComponent(String(get('cf-ipcity') || get('x-vercel-ip-city') || get('x-appengine-city') || '')).trim().slice(0, 64); } catch { return ''; }
}
