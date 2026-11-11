import * as fs from 'node:fs';
import * as path from 'node:path';

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/** Canonical form for comparing paths: realpath (if it exists), no trailing separator, case-folded on macOS/Windows. */
export function canonicalPath(p: string): string {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch { /* missing path: compare as-is */ }
  if (r.length > 1 && (r.endsWith('/') || r.endsWith('\\'))) r = r.slice(0, -1);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

export function exists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}

/** Nearest ancestor (including p) that exists on disk. */
export function nearestExisting(p: string): string {
  let cur = path.resolve(p);
  while (!exists(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
