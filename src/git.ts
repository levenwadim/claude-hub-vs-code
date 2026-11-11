import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { canonicalPath, nearestExisting } from './paths.ts';

export interface ProjectKey {
  /** Grouping key: git common dir, or the folder itself for non-git cwd. */
  key: string;
  /** Main folder of the project (parent of .git for normal repos). */
  mainPath: string;
  name: string;
}

export type GitCommonDir = (cwd: string) => Promise<string | undefined>;

export const gitCommonDir: GitCommonDir = (cwd) =>
  new Promise((resolve) => {
    execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 5000 }, (err, out) => {
      resolve(err ? undefined : out.trim() || undefined);
    });
  });

/** Resolve project for a chat cwd. Deleted worktrees fall back to the nearest existing ancestor. */
export async function projectFor(cwd: string, git: GitCommonDir = gitCommonDir): Promise<ProjectKey> {
  const probe = nearestExisting(cwd);
  const common = await git(probe);
  // Canonical keys: the same folder may arrive as "C:\x" from Claude and "c:\x" from VS Code, or "C:/x" from git.
  if (!common) return { key: canonicalPath(cwd), mainPath: cwd, name: path.basename(cwd) || cwd };
  const mainPath = path.resolve(path.basename(common) === '.git' ? path.dirname(common) : common);
  return { key: canonicalPath(common), mainPath, name: path.basename(mainPath) };
}
