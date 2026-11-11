import * as vscode from 'vscode';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatList } from './list.ts';
import type { Chat, Project } from './store.ts';
import { contentSearch } from './grep.ts';
import { cfg } from './opener.ts';

const RECENT = 50;
const MAX_RESULTS = 200;

/** ripgrep shipped with VS Code (location differs between versions), else `rg` on PATH. */
function ripgrep(): string {
  const root = vscode.env.appRoot;
  const arch = `${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [
    path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', arch, exe),
    path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
    path.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? exe;
}

type Item = vscode.QuickPickItem & { id?: string };

/** Command-palette-style search: recent chats when empty, then title matches followed by content matches. */
export function showSearch(list: ChatList) {
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = 'Search sessions by title or content';
  const all: { chat: Chat; project: Project }[] = list.projects
    .flatMap((project) => project.chats.map((chat) => ({ chat, project })))
    .sort((a, b) => b.chat.lastActivity - a.chat.lastActivity);
  // alwaysShow: we do the matching (content matches would otherwise be hidden by QuickPick's own label filter).
  const item = (x: { chat: Chat; project: Project }): Item =>
    ({ label: x.chat.title, description: x.project.name, id: x.chat.id, alwaysShow: true });
  const recent = () => [{ label: 'Recent', kind: vscode.QuickPickItemKind.Separator } as Item, ...all.slice(0, RECENT).map((x) => item(x))];
  qp.items = recent();

  const rg = ripgrep();
  const projectsDir = path.join(cfg().claudeDir, 'projects');
  let running: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let seq = 0;

  qp.onDidChangeValue((v) => {
    const q = v.trim();
    clearTimeout(timer);
    running?.kill();
    if (!q) { qp.busy = false; qp.items = recent(); return; }
    const ql = q.toLowerCase();
    const byTitle = all.filter((x) => x.chat.title.toLowerCase().includes(ql)).slice(0, MAX_RESULTS);
    const titleIds = new Set(byTitle.map((x) => x.chat.id));
    const titleItems = byTitle.length ? [{ label: 'Title', kind: vscode.QuickPickItemKind.Separator } as Item, ...byTitle.map((x) => item(x))] : [];
    qp.items = titleItems;
    qp.busy = true;
    const my = ++seq;
    timer = setTimeout(async () => {
      const s = contentSearch(rg, projectsDir, q);
      running = s.proc;
      const files = await s.files;
      if (my !== seq) return;
      const byContent = all.filter((x) => !titleIds.has(x.chat.id) && files.has(path.resolve(x.chat.file))).slice(0, MAX_RESULTS);
      qp.items = [...titleItems, ...(byContent.length ? [{ label: 'Content', kind: vscode.QuickPickItemKind.Separator } as Item, ...byContent.map((x) => item(x))] : [])];
      if (!qp.items.length) qp.items = [{ label: 'No matching sessions', alwaysShow: true }];
      qp.busy = false;
    }, 200);
  });

  qp.onDidAccept(() => {
    const id = qp.selectedItems[0]?.id;
    if (!id) return;
    qp.hide();
    vscode.commands.executeCommand('claudeHub.showChat', id);
  });
  qp.onDidHide(() => { clearTimeout(timer); running?.kill(); qp.dispose(); });
  qp.show();
}
