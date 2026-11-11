import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeta, promptText } from '../../src/sessionMeta.ts';
import { jsonl, rec, SID, user } from './helpers.ts';

test('cwd from first record, title from first real prompt', () => {
  const text = jsonl([
    { type: 'queue-operation', sessionId: SID },
    'not json {',
    user('<command-name>/clear</command-name>', { cwd: '/a b/café' }),
    user('meta', { isMeta: true, cwd: '/x' }),
    user([{ type: 'tool_result', content: 'r' }], { cwd: '/x' }),
    user('  Fix   the\nbug please ', { cwd: '/y' }),
  ]);
  const m = parseMeta(SID, text, '', true);
  assert.equal(m.cwd, '/a b/café');
  assert.equal(m.title, 'Fix the bug please');
});

test('last custom-title wins; relocated overrides cwd; tail is used', () => {
  const head = jsonl([user('hello', { cwd: '/start' }), { type: 'custom-title', customTitle: 'Old', sessionId: SID }]) + '{"type":"us';
  const tail = 'artial"}\n' + jsonl([{ type: 'custom-title', customTitle: 'New name', sessionId: SID }, { type: 'relocated', relocatedCwd: '/moved', sessionId: SID }]);
  const m = parseMeta(SID, head, tail, false);
  assert.equal(m.title, 'New name');
  assert.equal(m.cwd, '/moved');
});

test('title order: custom-title > last ai-title > first prompt', () => {
  const ai = (t: string) => ({ type: 'ai-title', aiTitle: t, sessionId: SID });
  assert.equal(parseMeta(SID, jsonl([user('hello', { cwd: '/c' }), ai('First AI'), ai('Claude limits in the extension')]), '', true).title, 'Claude limits in the extension');
  assert.equal(parseMeta(SID, jsonl([user('hello', { cwd: '/c' }), ai('AI'), { type: 'custom-title', customTitle: 'Mine', sessionId: SID }]), '', true).title, 'Mine');
  assert.equal(parseMeta(SID, jsonl([user('hello', { cwd: '/c' }), ai('  ')]), '', true).title, 'hello');
});

test('long titles are truncated', () => {
  const m = parseMeta(SID, jsonl([user('x'.repeat(500), { cwd: '/c' })]), '', true);
  assert.equal(m.title!.length, 80);
  assert.ok(m.title!.endsWith('…'));
});

test('promptText ignores non-user and sidechain', () => {
  assert.equal(promptText(rec('assistant', { message: { content: 'hi' } })), undefined);
  assert.equal(promptText(user('hi', { isSidechain: true })), undefined);
  assert.equal(promptText(user([{ type: 'text', text: 'array prompt' }])), 'array prompt');
  assert.equal(promptText(null), undefined);
});

test('activity: last user/assistant timestamp; bookkeeping records written on reload do not count', () => {
  const text = jsonl([
    user('hi', { cwd: '/p', timestamp: '2026-01-01T10:00:00.000Z' }),
    { type: 'assistant', sessionId: SID, timestamp: '2026-01-01T10:00:05.000Z', message: { role: 'assistant', content: [] } },
    { type: 'cost-state', sessionId: SID, totalCostUSD: 1 },
    { type: 'tools-used', sessionId: SID, tools: [] },
  ]);
  assert.equal(parseMeta(SID, text, '', true).activity, Date.parse('2026-01-01T10:00:05.000Z'));
  assert.equal(parseMeta(SID, jsonl([{ type: 'cost-state', sessionId: SID }]), '', true).activity, undefined);
});
