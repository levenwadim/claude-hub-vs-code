import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { Chat, Project, SessionStore } from './store.ts';
import { cfg, visibleClaudeTabLabels, hubTerminal, isLastSidebarSession, labelMatches, openInClaude, openInFolder, opensNewWindow } from './opener.ts';
import { exists, UUID_RE } from './paths.ts';
import { ReadState } from './unread.ts';
import { ChatViewer } from './viewer.ts';

const COLLAPSED_KEY = 'claudeHub.collapsed';
const PAGE = 20;

type Status = 'running' | 'unread' | 'idle';

/** Plain data sent to the webview; titles are inserted with textContent there. */
interface ProjectModel {
  key: string;
  name: string;
  collapsed: boolean;
  chats: { id: string; title: string; status: Status; unread: boolean }[];
  more: number;
}

/** Sidebar list of projects → chats, rendered as a webview so spacing and layout match the desktop app. */
export class ChatList implements vscode.WebviewViewProvider {
  projects: Project[] = [];
  private scanning?: Promise<void>;
  private collapsed: Set<string>;
  private shown = new Map<string, number>(); // project key → visible chat count
  private selected?: string;
  private activeKey?: string; // project of this window's folder: always listed first
  private view?: vscode.WebviewView;
  private sent = '';
  private reads: ReadState;

  constructor(private store: SessionStore, private state: vscode.Memento, private extensionUri: vscode.Uri, private ctx: vscode.ExtensionContext) {
    this.collapsed = new Set(state.get<string[]>(COLLAPSED_KEY, []));
    this.reads = new ReadState(state);
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    view.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('list.css')}">
</head><body>
<div id="actions"><button id="new" class="action"><span class="icon plus-icon"></span>New</button><button id="search" class="action"><span class="icon search-icon"></span>Search</button></div>
<nav id="list" aria-label="Claude Code sessions"></nav>
<script nonce="${nonce}" src="${uri('list.js')}"></script>
</body></html>`;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.repaint(true));
  }

  private onMessage(m: any) {
    if (!m || typeof m !== 'object') return;
    const known = (k: unknown) => typeof k === 'string' && this.projects.some((p) => p.key === k);
    switch (m.type) {
      case 'ready': return this.repaint(true);
      case 'newChat': {
        if (m.key === undefined) return void this.newChat();
        if (known(m.key)) this.newChatIn(m.key);
        return;
      }
      case 'open':
        if (typeof m.id === 'string' && UUID_RE.test(m.id) && this.findChat(m.id)) vscode.commands.executeCommand('claudeHub.showChat', m.id);
        return;
      case 'toggle':
        if (known(m.key)) this.setCollapsed(m.key, !this.collapsed.has(m.key));
        return;
      case 'more':
        if (known(m.key)) { this.shown.set(m.key, (this.shown.get(m.key) ?? PAGE) + PAGE); this.repaint(); }
        return;
      case 'search': vscode.commands.executeCommand('claudeHub.search'); return;
    }
  }

  private setCollapsed(key: string, collapsed: boolean) {
    if (collapsed) this.collapsed.add(key); else this.collapsed.delete(key);
    this.state.update(COLLAPSED_KEY, [...this.collapsed]);
    this.repaint();
  }

  /**
   * "+" on a project: new Claude Code session right here if this window's folder belongs to the project
   * (main folder or one of its worktrees); otherwise, after confirmation, in a new window of the project's main folder.
   */
  private async newChatIn(key: string) {
    const p = this.projects.find((x) => x.key === key);
    if (!p) return;
    try {
      const first = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (first?.scheme === 'file' && (await this.store.project(first.fsPath)).key === p.key) {
        return await openInClaude(undefined, first.fsPath);
      }
      if (!exists(p.mainPath)) return void vscode.window.showErrorMessage(`Claude Hub: folder no longer exists: ${p.mainPath}`);
      const go = opensNewWindow() ? 'Open new window' : 'Open project';
      const pick = await vscode.window.showInformationMessage(
        `Open "${p.name}" in ${opensNewWindow() ? 'a new window' : 'this window'} and start a new Claude Code session?`,
        { modal: true, detail: p.mainPath }, go);
      if (pick === go) await openInFolder(this.ctx, undefined, p.mainPath);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Claude Hub: ${e?.message ?? e}`);
    }
  }

  /** Top "New chat": new session in this window's folder; in a window without a folder, pick a project first. */
  async newChat() {
    const first = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (first?.scheme === 'file') {
      return openInClaude(undefined, first.fsPath).catch((e) => vscode.window.showErrorMessage(`Claude Hub: ${e?.message ?? e}`));
    }
    const pick = await vscode.window.showQuickPick(
      this.projects.map((p) => ({ label: p.name, description: p.mainPath, key: p.key })),
      { placeHolder: 'Project for the new Claude Code session' });
    if (pick) await this.newChatIn(pick.key);
  }

  select(id: string) { this.selected = id; this.reads.markRead(id); this.repaint(); }

  setUnread(id: string, unread: boolean) {
    if (!this.findChat(id)) return;
    if (unread) this.reads.markUnread(id); else this.reads.markRead(id);
    this.repaint();
  }

  /** Rescan (cheap: stat + cached metadata). Concurrent calls share one scan. */
  refresh(): Promise<void> {
    return (this.scanning ??= this.store.scan(cfg().claudeDir).then(async (p) => {
      const first = vscode.workspace.workspaceFolders?.[0]?.uri;
      this.activeKey = first?.scheme === 'file' ? (await this.store.project(first.fsPath)).key : undefined;
      this.projects = p;
      this.repaint();
    }).finally(() => { this.scanning = undefined; }));
  }

  /** Send the model to the webview, unless nothing changed since the last send (the poll calls this every 5 s). */
  repaint(force = false) {
    if (!this.view?.visible) return;
    const msg = { type: 'model', projects: this.model(), selected: this.selected };
    const key = JSON.stringify(msg);
    if (!force && key === this.sent) return;
    this.sent = key;
    this.view.webview.postMessage(msg);
  }

  findChat(id: string): { chat: Chat; project: Project } | undefined {
    for (const project of this.projects) {
      const chat = project.chats.find((c) => c.id === id);
      if (chat) return { chat, project };
    }
  }

  model(): ProjectModel[] {
    const labels = visibleClaudeTabLabels();
    const activeMs = cfg().activeThresholdMs;
    // Active project first, the rest keep their recency order (sort is stable).
    const ordered = [...this.projects].sort((a, b) => Number(b.key === this.activeKey) - Number(a.key === this.activeKey));
    return ordered.map((p) => {
      const n = this.shown.get(p.key) ?? PAGE;
      return {
        key: p.key,
        name: p.name,
        collapsed: this.collapsed.has(p.key),
        chats: p.chats.slice(0, n).map((c) => {
          if (isHere(c, labels)) this.reads.seen(c.id, c.lastActivity);
          const unread = this.reads.isUnread(c.id, c.lastActivity);
          const status: Status = Date.now() - c.lastActivity < activeMs ? 'running' : unread ? 'unread' : 'idle';
          return { id: c.id, title: c.title, status, unread };
        }),
        more: Math.max(0, p.chats.length - n),
      };
    });
  }
}

/** The session is on screen in this window: in Claude Code, a Hub terminal, or the history viewer. */
function isHere(c: Chat, labels: string[]): boolean {
  return !!hubTerminal(c.id) || isLastSidebarSession(c.id) || ChatViewer.isVisible(c.id)
    || labels.some((l) => labelMatches(l, c.title) || labelMatches(l, c.agentName));
}
