import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadState, type Store } from '../../src/unread.ts';

function memStore(): Store & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: (k) => data[k] as any, update: async (k, v) => { data[k] = structuredClone(v); } };
}

test('unread: old sessions are read, new activity is unread until opened', () => {
  const s = memStore();
  const r = new ReadState(s, 1000);
  assert.equal(r.isUnread('a', 900), false, 'existed before install');
  assert.equal(r.isUnread('a', 1500), true, 'changed after install');
  r.markRead('a', 1600);
  assert.equal(r.isUnread('a', 1500), false);
  assert.equal(r.isUnread('a', 1700), true, 'new reply after reading');
});

test('unread: mark as unread survives being on screen; open clears it; state persists', () => {
  const s = memStore();
  const r = new ReadState(s, 1000);
  r.markUnread('a');
  r.seen('a', 5000);
  assert.equal(r.isUnread('a', 5000), true);
  r.markRead('a', 6000);
  assert.equal(r.isUnread('a', 5000), false);

  r.seen('b', 2000);
  assert.equal(r.isUnread('b', 2000), false, 'on screen means read');
  const again = new ReadState(s, 99999);
  assert.equal(again.isUnread('b', 2000), false, 'baseline and marks are persisted');
  assert.equal(again.isUnread('c', 1500), true, 'baseline is not reset on restart');
});
