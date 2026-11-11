// Runs inside VS Code, in a window without a folder.
const vscode = require('vscode');
const assert = require('node:assert/strict');

exports.run = async function run() {
  const { HUB_SID: sid, HUB_CWD: cwd } = process.env;
  const api = await vscode.extensions.getExtension('levenwadim.claude-hub').activate();
  assert.equal(vscode.workspace.workspaceFolders, undefined, 'no folder open');

  await api.list.refresh();
  const model = api.list.model();
  assert.equal(model.length, 1);
  assert.equal(model[0].name, 'Café project with spaces');
  assert.equal(model[0].chats.length, 20, 'first 20 chats only');
  assert.equal(model[0].more, 6, 'the rest behind Show more');
  assert.equal(model[0].chats[0].id, sid, 'most recent first');

  assert.deepEqual(api.buttonState(cwd, cwd), { kind: 'folder' }, 'no-folder window → open folder');
  assert.equal(api.buttonState(cwd + '/gone', cwd).kind, 'folder', 'deleted worktree falls back to the main folder');
  assert.equal(api.buttonState(cwd + '/gone', cwd + '/gone2').kind, 'missing', 'nothing left to open');

  // Another folder: the chat opens as a preview tab.
  await vscode.commands.executeCommand('claudeHub.showChat', sid);
  const hasTab = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
    .some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('claudeHub.chat'));
  for (let i = 0; i < 50 && !hasTab(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(hasTab(), 'preview tab open');
  console.log('integration OK');
};
