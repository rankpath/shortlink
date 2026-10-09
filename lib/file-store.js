// File store: links.json (atomic rewrite) + clicks.ndjson (append). Everything is cached in memory.
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function createFileStore(dataDir) {
  const linksFile = join(dataDir, 'links.json');
  const clicksFile = join(dataDir, 'clicks.ndjson');
  let links = [];
  const clicks = new Map();
  let writes = Promise.resolve();
  const queue = (task) => { writes = writes.then(task).catch((err) => console.error('[short-link] write failed:', err.message)); return writes; };

  await mkdir(dataDir, { recursive: true });
  try { const raw = JSON.parse(await readFile(linksFile, 'utf8')); links = (raw.links || []).filter((l) => l && l.id && l.slug); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  for (const l of links) clicks.set(l.id, []);
  try {
    for (const line of (await readFile(clicksFile, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try { const c = JSON.parse(line); if (clicks.has(c.id)) clicks.get(c.id).push(c); } catch { /* skip corrupt line */ }
    }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }

  async function saveLinks() { const tmp = `${linksFile}.tmp`; await writeFile(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), links }, null, 2)); await rename(tmp, linksFile); }
  async function rewriteClicks() { const lines = []; for (const list of clicks.values()) for (const c of list) lines.push(JSON.stringify(c)); const tmp = `${clicksFile}.tmp`; await writeFile(tmp, lines.length ? `${lines.join('\n')}\n` : ''); await rename(tmp, clicksFile); }

  return {
    getLinks: async () => links.map((l) => ({ ...l })),
    putLinks: async (next) => { links = next.map((l) => ({ ...l })); for (const l of links) if (!clicks.has(l.id)) clicks.set(l.id, []); for (const id of [...clicks.keys()]) if (!links.some((l) => l.id === id)) clicks.delete(id); await queue(saveLinks); },
    getClicks: async (id) => [...(clicks.get(id) || [])],
    getAllClicks: async () => new Map([...clicks.entries()].map(([id, list]) => [id, [...list]])),
    appendClick: async (id, click) => { if (!clicks.has(id)) clicks.set(id, []); clicks.get(id).push(click); await queue(() => appendFile(clicksFile, `${JSON.stringify(click)}\n`)); },
    deleteClicks: async (id) => { clicks.delete(id); await queue(rewriteClicks); },
    flush: () => writes,
    size: () => links.length
  };
}
