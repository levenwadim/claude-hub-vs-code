import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { samePath, nearestExisting, UUID_RE } from '../../src/paths.ts';
import { tmpDir } from './helpers.ts';

test('samePath: trailing slash, symlink, case on macOS/Windows', () => {
  const d = tmpDir();
  const real = path.join(d, 'Café folder with spaces');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(d, 'link'));
  assert.ok(samePath(real, real + '/'));
  assert.ok(samePath(real, path.join(d, 'link')));
  assert.ok(samePath(real, path.join(d, 'x', '..', 'Café folder with spaces')));
  assert.equal(samePath(real, real.toUpperCase()), process.platform === 'darwin' || process.platform === 'win32');
  assert.ok(!samePath(real, d));
});

test('nearestExisting walks up from a deleted path', () => {
  const d = tmpDir();
  assert.equal(nearestExisting(path.join(d, 'gone', 'deeper')), d);
});

test('UUID_RE', () => {
  assert.ok(UUID_RE.test('12345678-abcd-4ef0-9abc-123456789abc'));
  assert.ok(!UUID_RE.test('12345678-abcd-4ef0-9abc-123456789abc&prompt=x'));
  assert.ok(!UUID_RE.test('../etc'));
});
