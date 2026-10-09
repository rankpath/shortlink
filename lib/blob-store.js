// Netlify Blobs store: links in one JSON blob, one small blob per click (no lost writes under concurrency).
import { getStore } from '@netlify/blobs';

export function createBlobStore(name = 'short-link') {
  const store = getStore({ name, consistency: 'strong' });
  const LINKS = 'links.json';
  const clickKey = (id, click) => `clicks/${id}/${click.t.replace(/[:.]/g, '')}-${click.v}-${Math.random().toString(36).slice(2, 6)}`;
  async function readClicks(prefix) {
    const { blobs } = await store.list({ prefix });
    const out = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
    return out.filter(Boolean).sort((a, b) => a.t.localeCompare(b.t));
  }
  return {
    getLinks: async () => (await store.get(LINKS, { type: 'json' }))?.links || [],
    putLinks: async (links) => { await store.setJSON(LINKS, { version: 1, savedAt: new Date().toISOString(), links }); },
    getClicks: async (id) => readClicks(`clicks/${id}/`),
    getAllClicks: async () => {
      const all = await readClicks('clicks/');
      const map = new Map();
      for (const c of all) { if (!map.has(c.id)) map.set(c.id, []); map.get(c.id).push(c); }
      return map;
    },
    appendClick: async (id, click) => { await store.setJSON(clickKey(id, click), click); },
    deleteClicks: async (id) => { const { blobs } = await store.list({ prefix: `clicks/${id}/` }); await Promise.all(blobs.map((b) => store.delete(b.key))); }
  };
}
