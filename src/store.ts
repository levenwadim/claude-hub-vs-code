import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseMeta } from './sessionMeta.ts';
import { projectFor, type ProjectKey } from './git.ts';
import { UUID_RE } from './paths.ts';

export interface Chat {
  id: string;
  file: string;
  cwd: string;
  title: string;
  agentName?: string;
  /** Last conversation activity (ms): last user/assistant record, else file mtime. */
  lastActivity: number;
}

export interface Project extends ProjectKey {
  chats: Chat[];
  lastActivity: number;
}

interface CacheEntry { mtime: number; size: number; cwd?: string; title?: string; agentName?: string; activity?: number }

const HEAD = 64 * 1024;
const HEAD_MAX = 1024 * 1024;
const TAIL = 128 * 1024;

async function readRange(fh: fs.promises.FileHandle, start: number, len: number): Promise<string> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, start);
  return buf.subarray(0, bytesRead).toString('utf8');
}

async function readMeta(file: string, sessionId: string, size: number) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const tail = size > HEAD ? await readRange(fh, Math.max(0, size - TAIL), Math.min(TAIL, size)) : '';
    let meta = parseMeta(sessionId, await readRange(fh, 0, Math.min(HEAD, size)), tail, size <= HEAD);
    if ((!meta.title || !meta.cwd) && size > HEAD) {
      meta = parseMeta(sessionId, await readRange(fh, 0, Math.min(HEAD_MAX, size)), tail, size <= HEAD_MAX);
    }
    return meta;
  } finally {
    await fh.close();
  }
}

/** Scans <claudeDir>/projects/*\/*.jsonl, caching parsed metadata by mtime+size. Read-only. */
export class SessionStore {
  private cache = new Map<string, CacheEntry>();
  private projects = new Map<string, Promise<ProjectKey>>();

  private cacheFile?: string;
  private unsaved = false;
  private lastSave = 0;

  constructor(cacheFile?: string) {
    this.cacheFile = cacheFile;
    if (cacheFile) {
      try { this.cache = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))); } catch { /* no cache yet */ }
    }
  }

  project(cwd: string): Promise<ProjectKey> {
    let p = this.projects.get(cwd);
    if (!p) this.projects.set(cwd, (p = projectFor(cwd)));
    return p;
  }

  clearProjectCache() { this.projects.clear(); }

  async scan(claudeDir: string): Promise<Project[]> {
    const root = path.join(claudeDir, 'projects');
    let dirs: string[] = [];
    try { dirs = await fs.promises.readdir(root); } catch { return []; }
    const chats: Chat[] = [];
    const seen = new Set<string>();
    let dirty = false;
    await Promise.all(dirs.map(async (d) => {
      let names: string[];
      try { names = await fs.promises.readdir(path.join(root, d)); } catch { return; }
      await Promise.all(names.map(async (n) => {
        if (!n.endsWith('.jsonl')) return;
        const id = n.slice(0, -6);
        if (!UUID_RE.test(id)) return;
        const file = path.join(root, d, n);
        try {
          const st = await fs.promises.stat(file);
          seen.add(file);
          let e = this.cache.get(file);
          if (!e || e.mtime !== st.mtimeMs || e.size !== st.size) {
            const m = await readMeta(file, id, st.size);
            e = { mtime: st.mtimeMs, size: st.size, cwd: m.cwd, title: m.title, agentName: m.agentName, activity: m.activity ?? 0 };
            this.cache.set(file, e);
            dirty = true;
          }
          if (e.cwd) chats.push({ id, file, cwd: e.cwd, title: e.title ?? `(no prompt) ${id.slice(0, 8)}`, agentName: e.agentName, lastActivity: e.activity || e.mtime });
        } catch { /* unreadable file: skip */ }
      }));
    }));
    for (const k of this.cache.keys()) if (!seen.has(k)) { this.cache.delete(k); dirty = true; }
    if (dirty) this.unsaved = true;
    this.saveCache();

    const byKey = new Map<string, Project>();
    await Promise.all(chats.map(async (c) => {
      const pk = await this.project(c.cwd);
      let p = byKey.get(pk.key);
      if (!p) byKey.set(pk.key, (p = { ...pk, chats: [], lastActivity: 0 }));
      p.chats.push(c);
      p.lastActivity = Math.max(p.lastActivity, c.lastActivity);
    }));
    const list = [...byKey.values()];
    for (const p of list) p.chats.sort((a, b) => b.lastActivity - a.lastActivity);
    return list.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /** At most every 30 s: an active session changes the cache on every scan. A lost write only costs a re-read. */
  private saveCache() {
    if (!this.cacheFile || !this.unsaved || Date.now() - this.lastSave < 30_000) return;
    this.unsaved = false;
    this.lastSave = Date.now();
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(Object.fromEntries(this.cache)));
    } catch { /* cache is optional */ }
  }
}
