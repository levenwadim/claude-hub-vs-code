import { execFile, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

/** Files under <claudeDir>/projects whose raw content contains `query` (case-insensitive). */
export function contentSearch(rg: string, projectsDir: string, query: string): { files: Promise<Set<string>>; proc: ChildProcess } {
  let proc!: ChildProcess;
  const files = new Promise<Set<string>>((resolve) => {
    // execFile + `--`: the query is a plain argument, never parsed by a shell or as an rg flag.
    proc = execFile(rg, ['--files-with-matches', '--fixed-strings', '--ignore-case', '--no-messages', '--max-depth', '2', '--glob', '*.jsonl', '--', query, projectsDir],
      { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
      (_err, out) => resolve(new Set(String(out ?? '').split('\n').filter(Boolean).map((f) => path.resolve(f)))));
  });
  return { files, proc };
}
