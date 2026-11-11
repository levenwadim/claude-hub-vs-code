import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalPath, UUID_RE } from './paths.ts';

export const PENDING_TTL_MS = 60_000;

/** Request left for the window of `cwd`: resume `sessionId`, or start a new session when it is absent. */
export interface Pending { sessionId?: string; cwd: string; createdAt: number }

const fileFor = (dir: string, folder: string) =>
  path.join(dir, crypto.createHash('sha1').update(canonicalPath(folder)).digest('hex') + '.json');

export function writePending(dir: string, sessionId: string | undefined, cwd: string, now = Date.now()): void {
  fs.mkdirSync(dir, { recursive: true });
  const p: Pending = { sessionId, cwd, createdAt: now };
  fs.writeFileSync(fileFor(dir, cwd), JSON.stringify(p));
}

/** Read and delete the pending request for `folder`. Returns it only if fresh and valid. */
export function takePending(dir: string, folder: string, now = Date.now()): Pending | undefined {
  const f = fileFor(dir, folder);
  let raw: string;
  try {
    raw = fs.readFileSync(f, 'utf8');
    fs.unlinkSync(f);
  } catch { return; }
  try {
    const p = JSON.parse(raw);
    if (p.sessionId !== undefined && !(typeof p.sessionId === 'string' && UUID_RE.test(p.sessionId))) return;
    if (typeof p.cwd !== 'string' || typeof p.createdAt !== 'number') return;
    if (now - p.createdAt > PENDING_TTL_MS || p.createdAt > now + 5000) return;
    return p;
  } catch { return; }
}
