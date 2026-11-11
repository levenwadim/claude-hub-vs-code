import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionStore } from './store.ts';
import { ChatList } from './list.ts';
import { ChatViewer, buttonState, targetFolder } from './viewer.ts';
import { showSearch } from './search.ts';
import { takePending } from './pending.ts';
import { openInClaude, pendingDir } from './opener.ts';
import { samePath, UUID_RE } from './paths.ts';

export function activate(ctx: vscode.ExtensionContext) {
  // Bump the name when parsed metadata changes meaning; the old file is dropped.
  fs.rmSync(path.join(ctx.globalStorageUri.fsPath, 'meta-cache.json'), { force: true });
  const store = new SessionStore(path.join(ctx.globalStorageUri.fsPath, 'meta-cache-v2.json'));
  const list = new ChatList(store, ctx.globalState, ctx.extensionUri, ctx);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeHub.chats', list));

  const refresh = () => list.refresh().catch((e) => console.error('Claude Hub scan failed', e));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeHub.refresh', () => { store.clearProjectCache(); return refresh(); }),
    // `.checked` twins carry the ✓ in their title: VS Code ignores `toggled` on extension commands.
    ...(['panel', 'sidebar', 'terminal'] as const).flatMap((mode) => ['', '.checked'].map((s) => vscode.commands.registerCommand(`claudeHub.openMode.${mode}${s}`,
      () => vscode.workspace.getConfiguration('claudeHub').update('openMode', mode, vscode.ConfigurationTarget.Global)))),
    // Context menu of a session row; the argument is the row's data-vscode-context.
    ...([['claudeHub.markUnread', true], ['claudeHub.markRead', false]] as const).map(([cmd, unread]) => vscode.commands.registerCommand(cmd,
      (c: unknown) => { const id = (c as any)?.sessionId; if (typeof id === 'string' && UUID_RE.test(id)) list.setUnread(id, unread); })),
    vscode.commands.registerCommand('claudeHub.newChat', () => list.newChat()),
    vscode.commands.registerCommand('claudeHub.search', async () => { if (!list.projects.length) await refresh(); showSearch(list); }),
    vscode.commands.registerCommand('claudeHub.showChat', async (id: string) => {
      if (!list.findChat(id)) await refresh();
      const f = list.findChat(id);
      if (!f) return;
      list.select(id);
      // Same folder as this window: Claude Code can resume it, so skip the preview. Otherwise show the read-only preview.
      if (buttonState(f.chat.cwd, f.project.mainPath).kind === 'open') {
        await openInClaude(id, targetFolder(f.chat.cwd, f.project.mainPath)!).catch((e) => vscode.window.showErrorMessage(`Claude Hub: ${e?.message ?? e}`));
      } else ChatViewer.show(f.chat, f.project, ctx);
    }),
  );

  // Polling only while this window is focused: stat()s are cheap and metadata is cached by mtime.
  const timer = setInterval(() => { if (vscode.window.state.focused) refresh(); }, 5000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  ctx.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => list.repaint()),
    vscode.window.onDidOpenTerminal(() => list.repaint()),
    vscode.window.onDidCloseTerminal(() => list.repaint()),
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) { ChatViewer.refreshButtons(); consumePending(ctx); refresh(); } }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { ChatViewer.refreshButtons(); consumePending(ctx); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('claudeHub')) { ChatViewer.refreshButtons(); refresh(); } }),
  );

  // Another window may drop a pending request for this folder while this window is already open.
  const dir = pendingDir(ctx);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const w = fs.watch(dir, () => consumePending(ctx));
    ctx.subscriptions.push({ dispose: () => w.close() });
  } catch { /* focus/activation checks still apply */ }

  consumePending(ctx);
  refresh();
  return { list, buttonState }; // used by integration tests
}

/** Step 2 of "open folder → open chat": pick up a fresh request addressed to this window's first folder. */
function consumePending(ctx: vscode.ExtensionContext) {
  const first = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (first?.scheme !== 'file') return;
  const p = takePending(pendingDir(ctx), first.fsPath);
  if (!p || !samePath(p.cwd, first.fsPath)) return;
  openInClaude(p.sessionId, p.cwd).catch((e) => vscode.window.showErrorMessage(`Claude Hub: ${e?.message ?? e}`));
}

export function deactivate() {}
