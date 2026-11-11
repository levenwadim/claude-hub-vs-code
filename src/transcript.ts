import * as fs from 'node:fs';
import { renderRecord, type Item } from './render.ts';

const CHUNK = 512 * 1024;
const NL = 0x0a;

// Records that start with {"type":"<x>" and are not user/assistant/system are metadata (titles, request blobs, ...),
// some of them huge: skip them without JSON.parse. Conversation records start with other keys, so they always parse.
const TYPE_PREFIX = Buffer.from('{"type":"');
const MESSAGE_TYPES = ['user', 'assistant', 'system'];

export function renderLine(buf: Buffer, off: number): Item | undefined {
  if (buf.length === 0) return;
  if (buf.subarray(0, TYPE_PREFIX.length).equals(TYPE_PREFIX)) {
    const type = buf.toString('latin1', TYPE_PREFIX.length, TYPE_PREFIX.length + 12).split('"')[0];
    if (!MESSAGE_TYPES.includes(type)) return;
  }
  try {
    return renderRecord(JSON.parse(buf.toString('utf8')), off, buf.length);
  } catch {
    return; // corrupt or partial line
  }
}

/**
 * Read records backward from `end` (a line boundary) until `want` items are collected or the file start is reached.
 * Returns items in file order and `start`, the line boundary where the next (older) page should end.
 */
export async function readPageBackward(file: string, end: number, want: number): Promise<{ items: Item[]; start: number }> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const items: Item[] = [];
    let pos = end;
    let carry = Buffer.alloc(0); // bytes [pos, pos+carry.length) not yet consumed; ends at a line boundary
    while (items.length < want) {
      if (pos > 0) {
        const n = Math.min(CHUNK, pos);
        pos -= n;
        const buf = Buffer.alloc(n);
        await fh.read(buf, 0, n, pos);
        carry = Buffer.concat([buf, carry]);
      }
      // Consume complete lines from the back of carry.
      while (items.length < want) {
        const searchFrom = carry.length >= 2 ? carry.length - 2 : -1;
        const i = searchFrom >= 0 ? carry.lastIndexOf(NL, searchFrom) : -1;
        if (i < 0 && pos > 0) break; // first line incomplete, need more bytes
        const line = carry.subarray(i + 1);
        const body = line[line.length - 1] === NL ? line.subarray(0, -1) : line;
        const it = renderLine(body, pos + i + 1);
        if (it) items.push(it);
        carry = carry.subarray(0, i + 1);
        if (carry.length === 0) break;
      }
      if (pos === 0 && carry.length === 0) break;
      if (pos === 0 && items.length >= want) break;
    }
    return { items: items.reverse(), start: pos + carry.length };
  } finally {
    await fh.close();
  }
}

/** Read complete lines in [from, size). Returns items and the offset after the last complete line. */
export async function readForward(file: string, from: number): Promise<{ items: Item[]; end: number }> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= from) return { items: [], end: from };
    const buf = Buffer.alloc(size - from);
    await fh.read(buf, 0, buf.length, from);
    const last = buf.lastIndexOf(NL);
    if (last < 0) return { items: [], end: from };
    const items: Item[] = [];
    let s = 0;
    while (s <= last) {
      const e = buf.indexOf(NL, s);
      const it = renderLine(buf.subarray(s, e), from + s);
      if (it) items.push(it);
      s = e + 1;
    }
    return { items, end: from + last + 1 };
  } finally {
    await fh.close();
  }
}

/** Re-render a single record without truncation. */
export async function readFull(file: string, off: number, len: number): Promise<Item | undefined> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, off);
    return renderRecord(JSON.parse(buf.toString('utf8')), off, len, true);
  } catch {
    return;
  } finally {
    await fh.close();
  }
}

/** Offset just after the last complete line (so a partially-written trailing line is picked up later). */
export async function completeEnd(file: string): Promise<number> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    let pos = size;
    while (pos > 0) {
      const n = Math.min(64 * 1024, pos);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, pos - n);
      const i = buf.lastIndexOf(NL);
      if (i >= 0) return pos - n + i + 1;
      pos -= n;
    }
    return 0;
  } finally {
    await fh.close();
  }
}
