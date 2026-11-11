import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { samePath, UUID_RE } from './paths.ts';
import { writePending } from './pending.ts';

export function cfg() {
  const c = vscode.workspace.getConfiguration('claudeHub');
  const dir = c.get<string>('claudeDir')?.trim();
  return {
    openMode: c.get<'panel' | 'sidebar' | 'terminal'>('openMode', 'sidebar'),
    openFolderInNewWindow: c.get<boolean>('openFolderInNewWindow', true),
    claudeDir: dir ? dir.replace(/^~(?=$|[/\\])/, os.homedir()) : path.join(os.homedir(), '.claude'),
    claudePath: c.get<string>('claudePath')?.trim() || 'claude',
    activeThresholdMs: Math.max(1, c.get<number>('activeThresholdSeconds', 15)) * 1000,
  };
}

const TERMINAL_PREFIX = 'Claude ';

export function hubTerminal(sessionId: string): vscode.Terminal | undefined {
  return vscode.window.terminals.find((t) => {
    const o = t.creationOptions as vscode.TerminalOptions;
    return t.exitStatus === undefined && Array.isArray(o?.shellArgs) && o.shellArgs.includes(sessionId);
  });
}

/**
 * Open `sessionId` (a new session when undefined) in this window. Panel/sidebar modes call the commands the Claude
 * Code `vscode://anthropic.claude-code/open` URI handler delegates to, so the request stays in this window; the URI
 * is only a fallback.
 */
export async function openInClaude(sessionId: string | undefined, cwd: string): Promise<void> {
  if (sessionId !== undefined && !UUID_RE.test(sessionId)) throw new Error('Invalid session id');
  const c = cfg();
  if (c.openMode === 'terminal') {
    const existing = sessionId && hubTerminal(sessionId);
    if (existing) return existing.show();
    // shellPath + shellArgs: spawned directly, no shell parsing of the id or path.
    vscode.window.createTerminal({
      name: 'Claude ' + (sessionId?.slice(0, 8) ?? 'new'),
      cwd,
      shellPath: c.claudePath,
      shellArgs: sessionId ? ['--resume', sessionId] : [],
    }).show();
    return;
  }
  try {
    if (c.openMode === 'sidebar' && await sidebarAllowed()) {
      // Claude Code uses its sidebar only with this flag and claudeCode.preferredLocation = "sidebar"
      // (a session already open in a tab is revealed there instead).
      await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' });
      lastSidebarSession = sessionId;
    } else {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
    }
  } catch {
    const ok = await vscode.env.openExternal(vscode.Uri.parse(`vscode://anthropic.claude-code/open${sessionId ? `?session=${sessionId}` : ''}`));
    if (!ok) throw new Error('Claude Code extension (anthropic.claude-code) is not available. Install it or set claudeHub.openMode to "terminal".');
  }
}

export function pendingDir(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, 'pending');
}

/**
 * Open the session in the window whose first folder is `cwd`: here if it matches, otherwise leave a pending request
 * and open the folder; Hub in that window picks it up (see consumePending).
 */
/** A window without a folder is reused for the project instead of spawning another one. */
export const opensNewWindow = (): boolean => cfg().openFolderInNewWindow && !!vscode.workspace.workspaceFolders?.length;

export async function openInFolder(ctx: vscode.ExtensionContext, sessionId: string | undefined, cwd: string): Promise<void> {
  const first = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (first?.scheme === 'file' && samePath(first.fsPath, cwd)) return openInClaude(sessionId, cwd);
  writePending(pendingDir(ctx), sessionId, cwd);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), { forceNewWindow: opensNewWindow() });
}

// shortcut: Claude Code does not expose which session its sidebar shows; we assume the last one Hub put there.
let lastSidebarSession: string | undefined;
export const isLastSidebarSession = (id: string) => lastSidebarSession === id;

/** Claude Code's own setting decides sidebar vs tab; change it only with the user's consent. */
async function sidebarAllowed(): Promise<boolean> {
  const cc = vscode.workspace.getConfiguration('claudeCode');
  if (cc.get('preferredLocation') === 'sidebar') return true;
  const yes = 'Switch to sidebar';
  const pick = await vscode.window.showInformationMessage(
    'Claude Code opens sessions in an editor tab (claudeCode.preferredLocation = "panel"). Switch it to "sidebar" so Claude Hub can open sessions there?',
    yes, 'Use tab',
  );
  if (pick !== yes) return false;
  await cc.update('preferredLocation', 'sidebar', vscode.ConfigurationTarget.Global);
  return true;
}

/** Same rule Claude Code uses to match its panel tab label (truncated with "…") to a session title. */
export function labelMatches(label: string, title: string | undefined): boolean {
  if (!title) return false;
  const n = (s: string) => s.replace(/\s+/g, ' ').trim();
  const l = n(label), t = n(title);
  if (!l || !t) return false;
  if (l.endsWith('…')) {
    const p = l.slice(0, -1);
    return p !== '' && t.startsWith(p);
  }
  return l === t;
}

/** Labels of Claude Code tabs that are on screen (the active tab of each editor group); background tabs are not. */
export function visibleClaudeTabLabels(): string[] {
  const out: string[] = [];
  for (const g of vscode.window.tabGroups.all) {
    const t = g.activeTab;
    if (t?.input instanceof vscode.TabInputWebview && t.input.viewType.includes('claudeVSCodePanel')) out.push(t.label);
  }
  return out;
}
