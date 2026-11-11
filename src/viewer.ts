import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Chat, Project } from './store.ts';
import { completeEnd, readForward, readFull, readPageBackward } from './transcript.ts';
import { exists, samePath } from './paths.ts';
import { cfg, openInFolder, opensNewWindow } from './opener.ts';

const PAGE = 60;

export type ButtonState = { kind: 'open' | 'folder' | 'missing' };

/** Folder the chat is opened in: its own cwd, or the project's main folder once its worktree is deleted. */
export function targetFolder(cwd: string, mainPath: string): string | undefined {
  return exists(cwd) ? cwd : exists(mainPath) ? mainPath : undefined;
}

export function buttonState(cwd: string, mainPath: string): ButtonState {
  const target = targetFolder(cwd, mainPath);
  if (!target) return { kind: 'missing' };
  const first = vscode.workspace.workspaceFolders?.[0]?.uri;
  return { kind: first?.scheme === 'file' && samePath(first.fsPath, target) ? 'open' : 'folder' };
}

export class ChatViewer {
  private static open = new Map<string, ChatViewer>();
  private start = 0; // earliest loaded line boundary
  private end = 0; // offset after last rendered line
  private disposables: vscode.Disposable[] = [];
  private reading = Promise.resolve();

  static show(chat: Chat, project: Project, ctx: vscode.ExtensionContext) {
    const v = ChatViewer.open.get(chat.id);
    if (v) { v.project = project; v.panel.reveal(); v.sendButton(); return; }
    ChatViewer.open.set(chat.id, new ChatViewer(chat, project, ctx));
  }

  static isVisible(id: string): boolean { return !!ChatViewer.open.get(id)?.panel.visible; }

  static refreshButtons() {
    for (const v of ChatViewer.open.values()) v.sendButton();
  }

  private panel: vscode.WebviewPanel;

  private constructor(private chat: Chat, private project: Project, private ctx: vscode.ExtensionContext) {
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('claudeHub.chat', chat.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'icon-light.svg'), dark: vscode.Uri.joinPath(media, 'icon-dark.svg') };
    this.panel.webview.html = this.html(media);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(() => this.panel.visible && this.sendButton(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);

    // fs.watch: the file is outside the workspace, where FileSystemWatcher is unreliable.
    try {
      const fw = fs.watch(chat.file, () => this.tail());
      this.disposables.push({ dispose: () => fw.close() });
    } catch { /* no live updates; the page still shows the history */ }
  }

  private post(m: unknown) { this.panel.webview.postMessage(m); }

  private serial(fn: () => Promise<void>) {
    this.reading = this.reading.then(fn).catch((e) => this.post({ type: 'error', text: String(e?.message ?? e) }));
  }

  private onMessage(m: any) {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'ready':
        this.serial(() => this.loadLatest());
        this.sendButton();
        return;
      case 'loadMore':
        this.serial(async () => {
          if (this.start <= 0) return;
          const { items, start } = await readPageBackward(this.chat.file, this.start, PAGE);
          this.start = start;
          this.post({ type: 'page', items, hasMore: start > 0 });
        });
        return;
      case 'full': {
        const off = m.off;
        // Only offsets we have already rendered (within the loaded range) are accepted.
        if (!Number.isSafeInteger(off) || off < this.start || off >= this.end) return;
        this.serial(async () => {
          const len = await lineLength(this.chat.file, off, this.end);
          const it = len ? await readFull(this.chat.file, off, len) : undefined;
          if (it) this.post({ type: 'replace', item: it });
        });
        return;
      }
      case 'primary':
        this.primary().catch((e) => vscode.window.showErrorMessage(`Claude Hub: ${e?.message ?? e}`));
        return;
    }
  }

  /** Button action; state is recomputed here, never taken from the webview. */
  private async primary() {
    const target = targetFolder(this.chat.cwd, this.project.mainPath);
    if (target) await openInFolder(this.ctx, this.chat.id, target);
  }

  /** (Re)load the newest page and tell the webview to start over. */
  private async loadLatest() {
    this.end = await completeEnd(this.chat.file);
    const { items, start } = await readPageBackward(this.chat.file, this.end, PAGE);
    this.start = start;
    this.post({ type: 'page', items, hasMore: start > 0, reset: true });
  }

  private tail() {
    this.serial(async () => {
      let size: number;
      try { size = (await fs.promises.stat(this.chat.file)).size; } catch { return; }
      if (size < this.end) return this.loadLatest(); // file rewritten
      if (size === this.end) return;
      const { items, end } = await readForward(this.chat.file, this.end);
      this.end = end;
      if (items.length) this.post({ type: 'append', items });
    });
  }

  sendButton() {
    const s = buttonState(this.chat.cwd, this.project.mainPath);
    // Only an existing worktree gets a label; the project's own folder and deleted worktrees show none.
    const worktree = exists(this.chat.cwd) && !samePath(this.chat.cwd, this.project.mainPath) ? path.basename(this.chat.cwd) : undefined;
    this.post({ type: 'button', state: s, cwd: this.chat.cwd, worktree, terminal: cfg().openMode === 'terminal', newWindow: opensNewWindow() });
  }

  private html(media: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const w = this.panel.webview;
    const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('viewer.css')}">
</head><body>
<main id="log"><div id="top" class="muted center">Loading…</div></main>
<footer id="bar"><span id="note" class="muted"></span><button id="primary" disabled>…</button></footer>
<script nonce="${nonce}" src="${uri('viewer.js')}"></script>
</body></html>`;
  }

  private dispose() {
    ChatViewer.open.delete(this.chat.id);
    for (const d of this.disposables) d.dispose();
  }
}

/** Length of the line starting at `off` (up to `limit`), without the newline. */
async function lineLength(file: string, off: number, limit: number): Promise<number> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    let pos = off;
    while (pos < limit) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, limit - pos), pos);
      if (!bytesRead) break;
      const i = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (i >= 0) return pos + i - off;
      pos += bytesRead;
    }
    return pos - off;
  } finally {
    await fh.close();
  }
}
