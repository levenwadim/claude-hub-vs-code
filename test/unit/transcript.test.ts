import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { completeEnd, readForward, readFull, readPageBackward, renderLine as readLine } from '../../src/transcript.ts';
import { renderRecord } from '../../src/render.ts';
import { assistant, jsonl, rec, tmpDir, user } from './helpers.ts';

function fixture(n: number): string {
  const recs: unknown[] = [];
  for (let i = 0; i < n; i++) {
    recs.push(user(`q${i}`, { cwd: '/c' }), { type: 'custom-title', customTitle: 't' }, 'garbage', assistant([{ type: 'text', text: `a${i} ` + 'x'.repeat(i % 7 === 0 ? 300_000 : 10) }]));
  }
  const f = path.join(tmpDir(), 's.jsonl');
  fs.writeFileSync(f, jsonl(recs));
  return f;
}

test('backward paging returns every message once, in order', async () => {
  const f = fixture(200);
  let end = await completeEnd(f);
  const all: string[] = [];
  let pages = 0;
  while (true) {
    const { items, start } = await readPageBackward(f, end, 25);
    all.unshift(...items.map((i) => i.html));
    pages++;
    if (start === 0) break;
    assert.ok(start < end);
    end = start;
  }
  assert.equal(all.length, 400);
  assert.ok(all[0].includes('q0') && all[399].includes('a199'));
  assert.equal(pages, 16);
});

test('readForward ignores a partially written last line', async () => {
  const f = path.join(tmpDir(), 's.jsonl');
  fs.writeFileSync(f, jsonl([user('one')]) + '{"type":"user","mess');
  const end = await completeEnd(f);
  const r = await readForward(f, 0);
  assert.equal(r.items.length, 1);
  assert.equal(r.end, end);
  fs.appendFileSync(f, 'age":{"content":"two"},"uuid":"u"}\n');
  const r2 = await readForward(f, r.end);
  assert.equal(r2.items.length, 1);
  assert.ok(r2.items[0].html.includes('two'));
});

test('long tool output truncated, full on request', async () => {
  const big = 'line\n'.repeat(5000);
  const f = path.join(tmpDir(), 's.jsonl');
  fs.writeFileSync(f, jsonl([user([{ type: 'tool_result', content: big }])]));
  const { items } = await readPageBackward(f, await completeEnd(f), 10);
  assert.ok(items[0].html.includes('class="full"'));
  assert.ok(items[0].html.length < big.length);
  const full = await readFull(f, items[0].off, items[0].len);
  assert.ok(full!.html.length > big.length && !full!.html.includes('class="full"'));
});

test('HTML in chat content is escaped (no script, no onerror)', () => {
  const evil = '<script>alert(1)</script> <img src=x onerror=alert(2)> ![p](http://evil/x.png) [l](javascript:alert(3))';
  for (const r of [user(evil), assistant([{ type: 'text', text: evil }]), user([{ type: 'tool_result', content: evil }]), assistant([{ type: 'tool_use', name: '<b>x</b>', input: { command: evil } }])]) {
    const html = renderRecord(r, 0, 0)!.html;
    assert.ok(!/<script/i.test(html), html);
    assert.ok(!/<img/i.test(html), html);
    assert.ok(!/href="javascript:/i.test(html), html);
    assert.ok(!/<b>x/.test(html), html);
  }
});

test('unknown records: metadata skipped, unknown message type marked unsupported', () => {
  assert.equal(renderRecord({ type: 'api-request-blob', message: {} }, 0, 0), undefined);
  assert.equal(renderRecord(rec('queue-operation'), 0, 0), undefined);
  assert.match(renderRecord(rec('new-kind', { message: { content: 'x' } }), 0, 0)!.html, /unsupported message: new-kind/);
  assert.match(renderRecord(assistant([{ type: 'weird' }]), 0, 0)!.html, /unsupported block: weird/);
});

test('dot kind: thinking-only is grey assistant, tool call is tool, result is result', () => {
  const kind = (r: any) => renderRecord(r, 0, 0)!.kind;
  assert.equal(kind(assistant([{ type: 'thinking', thinking: 'hm' }])), 'assistant thinking');
  assert.equal(kind(assistant([{ type: 'thinking', thinking: 'hm' }, { type: 'tool_use', name: 'Bash', input: {} }])), 'tool');
  assert.equal(kind(user([{ type: 'tool_result', content: 'x' }])), 'result');
  assert.equal(kind(assistant([{ type: 'text', text: 'hi' }])), 'assistant');
});

test('tool call and result carry matching ids for pairing', () => {
  const call = renderRecord(assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]), 0, 0)!;
  const res = renderRecord(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'out' }]), 0, 0)!;
  assert.match(call.html, /data-tool="toolu_1"/);
  assert.match(call.html, /data-key="IN:toolu_1"/);
  assert.match(res.html, /data-for="toolu_1"/);
  assert.match(res.html, /data-key="OUT:toolu_1"/);
  assert.ok(!/<img/.test(renderRecord(assistant([{ type: 'tool_use', id: '"><img onerror=x>', name: 'B', input: {} }]), 0, 0)!.html), 'ids are escaped');
});

test('50 MB session: first page and a full backward walk stay fast', async () => {
  const line = JSON.stringify(assistant([{ type: 'text', text: 'x'.repeat(20_000) }])) + '\n';
  const f = path.join(tmpDir(), 'big.jsonl');
  fs.writeFileSync(f, line.repeat(2600));
  assert.ok(fs.statSync(f).size > 50_000_000);
  const t0 = Date.now();
  const end = await completeEnd(f);
  let r = await readPageBackward(f, end, 60);
  const first = Date.now() - t0;
  let n = r.items.length;
  while (r.start > 0) { r = await readPageBackward(f, r.start, 60); n += r.items.length; }
  assert.equal(n, 2600);
  assert.ok(first < 500, `first page took ${first} ms`);
  assert.ok(Date.now() - t0 < 5000, 'full walk too slow');
});

test('metadata lines are skipped, conversation lines parse whatever their key order', () => {
  const meta = Buffer.from(JSON.stringify({ type: 'api-request-blob', uuid: 'u', message: { content: 'x' } }));
  assert.equal(readLine(meta, 0), undefined);
  assert.ok(readLine(Buffer.from(JSON.stringify(user("hello"))), 0));
  assert.ok(readLine(Buffer.from(JSON.stringify({ parentUuid: null, type: 'assistant', uuid: 'a', message: { content: 'hi' } })), 0));
});
