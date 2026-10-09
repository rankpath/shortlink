// Short Link on Netlify: one function serves the API and the redirects; static files come from public/.
import { createShortener, parseDomains } from '../../lib/core.js';
import { createBlobStore } from '../../lib/blob-store.js';

const env = (k) => (globalThis.Netlify ? Netlify.env.get(k) : process.env[k]) || '';
let app;
function getApp() {
  if (!app) {
    app = createShortener({
      config: { adminPassword: env('ADMIN_PASSWORD'), apiKey: env('API_KEY'), publicShorten: env('PUBLIC_SHORTEN') === 'true', sessionSecret: env('SESSION_SECRET'), domains: parseDomains(env('SHORT_DOMAINS') || env('BASE_URL')) },
      store: createBlobStore()
    });
  }
  return app;
}

export default async (req, context) => {
  const result = await getApp().handle(req, { ip: context.ip, country: context.geo?.country?.code, city: context.geo?.city });
  if (result instanceof Response) return result;
  context.waitUntil(result.pending);
  return result.response;
};

export const config = { path: ['/api/*', '/health', '/robots.txt', '/favicon.svg', '/favicon.ico', '/:slug'], preferStatic: true };
