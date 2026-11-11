import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionStore } from '../../src/store.ts';
import { contentSearch } from '../../src/grep.ts';
import { jsonl, tmpDir, user } from './helpers.ts';

test('scan groups by project, sorts by activity, caches by mtime', async () => {
  const d = tmpDir();
  const a = path.join(d, 'proj a'), b = path.join(d, 'café b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const pd = path.join(d, 'claude', 'projects', 'x');
  fs.mkdirSync(pd, { recursive: true });
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];
  const write = (id: string, cwd: string, t: string, mtime: number) => {
    const f = path.join(pd, id + '.jsonl');
    // Order comes from the record timestamp (last activity); mtime is the cache key.
    fs.writeFileSync(f, jsonl([user(t, { cwd, uuid: 'u', timestamp: new Date(mtime * 1000).toISOString() })]));
    fs.utimesSync(f, mtime, mtime);
  };
  write(ids[0], a, 'old in a', 1000);
  write(ids[1], b, 'in b', 2000);
  write(ids[2], a, 'new in a', 3000);
  fs.writeFileSync(path.join(pd, 'not-a-session.jsonl'), '');
  const cacheFile = path.join(d, 'cache.json');
  const ps = await new SessionStore(cacheFile).scan(path.join(d, 'claude'));
  assert.deepEqual(ps.map((p) => p.name), ['proj a', 'café b']);
  assert.deepEqual(ps[0].chats.map((c) => c.title), ['new in a', 'old in a']);
  // Cached entry is reused (file content changed but mtime+size restored -> old title stays).
  const f = path.join(pd, ids[1] + '.jsonl');
  fs.writeFileSync(f, jsonl([user('in c', { cwd: b, uuid: 'u', timestamp: new Date(2000 * 1000).toISOString() })]));
  fs.utimesSync(f, 2000, 2000);
  const ps2 = await new SessionStore(cacheFile).scan(path.join(d, 'claude'));
  assert.equal(ps2[1].chats[0].title, 'in b');
});

test('contentSearch finds files by content, case-insensitive, query is never a flag', async (t) => {
  // rg on PATH (any OS), or the one bundled with VS Code on macOS.
  const rg = ['rg', '/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/rg']
    .find((p) => spawnSync(p, ['--version']).status === 0);
  if (!rg) return t.skip('ripgrep not found');
  const d = path.join(tmpDir(), 'projects');
  fs.mkdirSync(path.join(d, 'p 1'), { recursive: true });
  const hit = path.join(d, 'p 1', 'a.jsonl'), miss = path.join(d, 'p 1', 'b.jsonl');
  fs.writeFileSync(hit, jsonl([user('Fix the CAFÉ TOKENIZER --files')]));
  fs.writeFileSync(miss, jsonl([user('something else')]));
  assert.deepEqual([...await contentSearch(rg, d, 'café tokenizer').files], [hit]);
  assert.deepEqual([...await contentSearch(rg, d, '--files').files], [hit]);
  assert.equal((await contentSearch(rg, d, 'no such text').files).size, 0);
});
