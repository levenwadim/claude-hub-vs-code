import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { takePending, writePending, PENDING_TTL_MS } from '../../src/pending.ts';
import { SID, tmpDir } from './helpers.ts';

test('write then take once; matched by realpath', () => {
  const d = tmpDir();
  const folder = path.join(d, 'café project A');
  fs.mkdirSync(folder);
  const store = path.join(d, 'pending');
  writePending(store, SID, folder, 1000);
  assert.equal(takePending(store, path.join(d, 'other'), 1000), undefined);
  assert.deepEqual(takePending(store, folder + '/', 2000), { sessionId: SID, cwd: folder, createdAt: 1000 });
  assert.equal(takePending(store, folder, 2000), undefined, 'consumed');
});

test('expired entries are ignored and deleted', () => {
  const d = tmpDir();
  writePending(d, SID, '/f', 0);
  assert.equal(takePending(d, '/f', PENDING_TTL_MS + 1), undefined);
  assert.equal(fs.readdirSync(d).length, 0);
});

test('request without a session id means "new session"; a bad id is rejected', () => {
  const d = tmpDir();
  writePending(d, undefined, '/f', 0);
  assert.deepEqual(takePending(d, '/f', 1), { cwd: '/f', createdAt: 0 });
  writePending(d, 'not-a-uuid', '/f', 0);
  assert.equal(takePending(d, '/f', 1), undefined);
});
