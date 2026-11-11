import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Set when tests are started from a VS Code terminal; it would make the test VS Code start as plain node.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hub int café ')));
const claudeDir = path.join(tmp, 'claude dir');
const cwd = path.join(tmp, 'Café project with spaces');
fs.mkdirSync(cwd);
const pd = path.join(claudeDir, 'projects', 'x');
fs.mkdirSync(pd, { recursive: true });
const sid = '0f0f0f0f-1111-4222-8333-444444444444';
const lines = [
  { type: 'user', uuid: 'u0', cwd, sessionId: sid, message: { role: 'user', content: 'XSS test <script>window.__pwned=1</script> <img src=x onerror="window.__pwned=2">' } },
];
for (let i = 0; i < 5; i++) {
  lines.push({ type: 'assistant', uuid: 'a' + i, cwd, sessionId: sid, message: { role: 'assistant', content: [{ type: 'text', text: `msg ${i}` }] } });
}
fs.writeFileSync(path.join(pd, sid + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
// 25 older chats in the same project, to exercise "Show more".
for (let i = 0; i < 25; i++) {
  const id = `0f0f0f0f-1111-4222-8333-${String(i).padStart(12, '0')}`;
  const f = path.join(pd, id + '.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'user', uuid: 'x', cwd, sessionId: id, message: { role: 'user', content: `small ${i}` } }) + '\n');
  fs.utimesSync(f, 1000 + i, 1000 + i);
}

// Short ASCII path: VS Code puts its IPC socket here and macOS limits socket paths to 104 bytes.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hubud'));
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'claudeHub.claudeDir': claudeDir }));

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test/integration/suite.cjs'),
    launchArgs: ['--user-data-dir', userData, '--disable-workspace-trust', '--skip-welcome'],
    extensionTestsEnv: { HUB_SID: sid, HUB_CWD: cwd },
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}
