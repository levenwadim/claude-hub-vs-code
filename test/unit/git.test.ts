import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectFor } from '../../src/git.ts';
import { canonicalPath } from '../../src/paths.ts';
import { tmpDir } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

test('main folder and its worktrees group into one project; non-git is its own', async () => {
  const d = tmpDir();
  const main = path.join(d, 'café repo');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(main, '.claude', 'worktrees', 'feature x');
  git(main, 'worktree', 'add', '-q', '-b', 'wt1', wt);
  const outside = path.join(d, 'wt outside');
  git(main, 'worktree', 'add', '-q', '-b', 'wt2', outside);
  fs.mkdirSync(path.join(main, 'sub dir'));

  const pm = await projectFor(main);
  assert.equal(pm.name, 'café repo');
  assert.equal(fs.realpathSync.native(pm.mainPath), fs.realpathSync.native(main));
  for (const p of [wt, outside, path.join(main, 'sub dir')]) assert.equal((await projectFor(p)).key, pm.key, p);

  // Deleted worktree under .claude/worktrees still maps to the main project.
  assert.equal((await projectFor(path.join(main, '.claude', 'worktrees', 'deleted'))).key, pm.key);

  const plain = path.join(d, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await projectFor(plain), { key: canonicalPath(plain), mainPath: plain, name: 'plain' });
});

test('bare/common dir not named .git', async () => {
  const p = await projectFor('/any', async () => '/srv/repo.git');
  assert.deepEqual(p, { key: canonicalPath('/srv/repo.git'), mainPath: path.resolve('/srv/repo.git'), name: 'repo.git' });
});
