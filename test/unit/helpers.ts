import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Temp dir whose name has spaces and non-ASCII, to exercise path handling. Native realpath expands Windows 8.3 names (RUNNER~1). */
export function tmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hub test café ')));
}

export const SID = '11111111-2222-4333-8444-555555555555';

export function rec(type: string, extra: Record<string, unknown> = {}) {
  return { type, uuid: Math.random().toString(36).slice(2), sessionId: SID, timestamp: new Date().toISOString(), ...extra };
}
export const user = (content: unknown, extra = {}) => rec('user', { message: { role: 'user', content }, ...extra });
export const assistant = (content: unknown) => rec('assistant', { message: { role: 'assistant', content } });
export const jsonl = (recs: unknown[]) => recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
