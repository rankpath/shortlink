// End-to-end smoke test: boots the real server on a random port with a temporary data directory.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-password-123';
const KEY = 'test-api-key-456';
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let dataDir, child, cookie = '';

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [join(root, 'server.js')], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD: PASSWORD, API_KEY: KEY, DATA_DIR: dataDir, SHORT_DOMAINS: 'https://s.example.test,https://go.example.test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { if (!out.includes('listening')) reject(new Error(`server exited early (${code}): ${out}`)); });
  });
}
function stopServer() {
  return new Promise((resolve) => { if (!child || child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); });
}
async function call(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth && cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, headers: res.headers, data };
}

before(async () => { dataDir = await mkdtemp(join(tmpdir(), 'shortener-test-')); await startServer(); });
after(async () => { await stopServer(); await rm(dataDir, { recursive: true, force: true }); });

let first, custom;

test('health and home page are public', async () => {
  const health = await call('/health');
  assert.equal(health.status, 200); assert.equal(health.data.ok, true);
  const home = await call('/');
  assert.equal(home.status, 200); assert.match(home.data, /Mergepdftool/);
  assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
  const qr = await call('/qr.js');
  assert.equal(qr.status, 200); assert.match(qr.data, /QRGen/);
});

test('session reports configuration and requires login to create', async () => {
  const session = await call('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.configured, true); assert.equal(session.data.authenticated, false);
  assert.deepEqual(session.data.domains, ['https://s.example.test', 'https://go.example.test']);
  const denied = await call('/api/links', { method: 'POST', body: { url: 'https://example.com' } });
  assert.equal(denied.status, 401);
  const list = await call('/api/links');
  assert.equal(list.status, 401);
});

test('login rejects a wrong password and sets a cookie on success', async () => {
  const wrong = await call('/api/login', { method: 'POST', body: { password: 'nope' } });
  assert.equal(wrong.status, 401);
  const ok = await call('/api/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie') || '';
  assert.match(setCookie, /shortener_session=/); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/);
  cookie = setCookie.split(';')[0];
  const session = await call('/api/session');
  assert.equal(session.data.authenticated, true);
});

test('creates a link with a generated slug on the default domain', async () => {
  const res = await call('/api/links', { method: 'POST', body: { url: 'example.com/landing?x=1', title: 'Landing', tags: 'promo, october' } });
  assert.equal(res.status, 201);
  first = res.data.link;
  assert.match(first.slug, /^[a-z0-9]{6}$/);
  assert.equal(first.url, 'https://example.com/landing?x=1');
  assert.equal(first.shortUrl, `https://s.example.test/${first.slug}`);
  assert.deepEqual(first.tags, ['promo', 'october']);
  assert.equal(first.status, 'active');
});

test('custom alias, second domain, and validation errors', async () => {
  const res = await call('/api/links', { method: 'POST', body: { url: 'https://example.org/page', slug: 'Promo-Oct', domain: 'go.example.test' } });
  assert.equal(res.status, 201);
  custom = res.data.link;
  assert.equal(custom.slug, 'promo-oct');
  assert.equal(custom.shortUrl, 'https://go.example.test/promo-oct');
  for (const [body, pattern] of [
    [{ url: 'https://example.org/other', slug: 'promo-oct' }, /already taken/],
    [{ url: 'https://example.org/other', slug: 'api' }, /reserved/],
    [{ url: 'https://example.org/other', slug: 'bad slug!' }, /Alias may use/],
    [{ url: 'ftp://example.org/file' }, /http and https/],
    [{ url: 'not a url' }, /valid/],
    [{ url: 'https://s.example.test/abc' }, /points to this shortener/],
    [{ url: 'https://example.org/x', domain: 'https://other.test' }, /not configured/],
    [{ url: 'https://example.org/x', expiresAt: 'never' }, /Expiry/]
  ]) {
    const bad = await call('/api/links', { method: 'POST', body });
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.match(bad.data.error, pattern);
  }
});

test('redirects and records clicks (case-insensitive slug, bots flagged)', async () => {
  const r1 = await call(`/${first.slug}`, { auth: false, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', referer: 'https://l.facebook.com/l.php?u=x', 'cf-ipcountry': 'TH' } });
  assert.equal(r1.status, 302); assert.equal(r1.headers.get('location'), first.url);
  assert.equal(r1.headers.get('cache-control'), 'no-store, max-age=0');
  const r2 = await call(`/${first.slug.toUpperCase()}`, { auth: false, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } });
  assert.equal(r2.status, 302);
  const bot = await call(`/${first.slug}`, { auth: false, headers: { 'user-agent': 'facebookexternalhit/1.1' } });
  assert.equal(bot.status, 302);
  const head = await call(`/${first.slug}`, { method: 'HEAD', auth: false });
  assert.equal(head.status, 302);
  const missing = await call('/does-not-exist', { auth: false });
  assert.equal(missing.status, 404);

  const stats = await call(`/api/links/${first.id}/stats?days=7`);
  assert.equal(stats.status, 200);
  assert.equal(stats.data.totals.clicks, 2);
  assert.equal(stats.data.totals.bots, 1);
  assert.equal(stats.data.totals.today, 2);
  assert.equal(stats.data.totals.visitors, 2);
  assert.equal(stats.data.timeline.length, 7);
  assert.equal(stats.data.timeline.at(-1).clicks, 2);
  assert.deepEqual(stats.data.devices.map((d) => d.name).sort(), ['desktop', 'mobile']);
  assert.ok(stats.data.browsers.some((b) => b.name === 'Safari'));
  assert.ok(stats.data.browsers.some((b) => b.name === 'Chrome'));
  assert.ok(stats.data.referrers.some((r) => r.name === 'l.facebook.com'));
  assert.ok(stats.data.referrers.some((r) => r.name === 'direct'));
  assert.ok(stats.data.countries.some((c) => c.name === 'TH'));
  assert.equal(stats.data.recent.length, 3);
});

test('list supports search, tag filter and sort; overview totals add up', async () => {
  const all = await call('/api/links');
  assert.equal(all.data.total, 2);
  assert.equal(all.data.links[0].id, custom.id, 'newest first');
  const byClicks = await call('/api/links?sort=clicks');
  assert.equal(byClicks.data.links[0].id, first.id);
  const search = await call('/api/links?q=landing');
  assert.equal(search.data.total, 1); assert.equal(search.data.links[0].id, first.id);
  const tagged = await call('/api/links?tag=october');
  assert.equal(tagged.data.total, 1);
  assert.ok(all.data.tags.some((tg) => tg.name === 'promo' && tg.count === 1));
  const overview = await call('/api/stats/overview?days=30');
  assert.equal(overview.data.totals.links, 2);
  assert.equal(overview.data.totals.clicks, 2);
  assert.equal(overview.data.topLinks[0].id, first.id);
  assert.equal(overview.data.timeline.length, 30);
});

test('edit: destination, alias, disable, expiry', async () => {
  const edit = await call(`/api/links/${custom.id}`, { method: 'PATCH', body: { url: 'https://example.org/new', slug: 'promo-nov', title: 'November', active: false } });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.link.slug, 'promo-nov'); assert.equal(edit.data.link.status, 'disabled');
  assert.equal((await call('/promo-oct', { auth: false })).status, 404);
  assert.equal((await call('/promo-nov', { auth: false })).status, 410);
  const on = await call(`/api/links/${custom.id}`, { method: 'PATCH', body: { active: true } });
  assert.equal(on.data.link.status, 'active');
  const go = await call('/promo-nov', { auth: false });
  assert.equal(go.status, 302); assert.equal(go.headers.get('location'), 'https://example.org/new');
  const expired = await call(`/api/links/${custom.id}`, { method: 'PATCH', body: { expiresAt: '2020-01-01T00:00:00Z' } });
  assert.equal(expired.data.link.status, 'expired');
  assert.equal((await call('/promo-nov', { auth: false })).status, 410);
  const clear = await call(`/api/links/${custom.id}`, { method: 'PATCH', body: { expiresAt: null } });
  assert.equal(clear.data.link.status, 'active');
  const bySlug = await call('/api/links/promo-nov');
  assert.equal(bySlug.data.link.id, custom.id);
});

test('API key works as a Bearer token; wrong key is rejected', async () => {
  const ok = await call('/api/links', { auth: false, headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(ok.status, 200); assert.equal(ok.data.total, 2);
  const bad = await call('/api/links', { auth: false, headers: { authorization: 'Bearer wrong' } });
  assert.equal(bad.status, 401);
  const created = await call('/api/links', { auth: false, method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: { url: 'https://example.net/api-made' } });
  assert.equal(created.status, 201);
  assert.equal((await call(`/api/links/${created.data.link.id}`, { method: 'DELETE' })).status, 204);
  const preflight = await fetch(`${base}/api/links`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});

test('bulk create reports successes and failures; CSV export works', async () => {
  const bulk = await call('/api/links/bulk', { method: 'POST', body: { items: [{ url: 'https://example.com/a', slug: 'bulk-a', title: 'A' }, { url: 'https://example.com/b' }, { url: 'nope' }] } });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.data.created.length, 2); assert.equal(bulk.data.errors.length, 1); assert.equal(bulk.data.errors[0].index, 2);
  const csv = await call('/api/export/links.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /^id,slug,short_url,destination/);
  assert.match(csv.data, /bulk-a/);
  const clicksCsv = await call(`/api/links/${first.id}/clicks.csv`);
  assert.match(clicksCsv.data, /^time,country,city,device/);
  assert.equal(clicksCsv.data.trim().split('\r\n').length, 4);
});

test('delete removes the link and its redirect', async () => {
  const del = await call(`/api/links/${custom.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal((await call('/promo-nov', { auth: false })).status, 404);
  assert.equal((await call(`/api/links/${custom.id}`)).status, 404);
});

test('data survives a restart (links, clicks, counts)', async () => {
  await stopServer();
  await startServer();
  const list = await call('/api/links');
  assert.equal(list.status, 200);
  assert.equal(list.data.total, 3);
  const again = list.data.links.find((l) => l.id === first.id);
  assert.ok(again, 'first link persisted');
  assert.equal(again.clicks, 2); assert.equal(again.botClicks, 1);
  const stats = await call(`/api/links/${first.id}/stats?days=7`);
  assert.equal(stats.data.totals.clicks, 2);
  const go = await call(`/${first.slug}`, { auth: false });
  assert.equal(go.status, 302);
});

test('login is rate limited', async () => {
  let last = 0;
  for (let i = 0; i < 12; i += 1) last = (await call('/api/login', { method: 'POST', body: { password: 'wrong' }, auth: false })).status;
  assert.equal(last, 429);
});
