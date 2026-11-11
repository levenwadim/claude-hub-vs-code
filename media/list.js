// Sidebar list. Titles come from chat content: inserted only via textContent. Clicks are postMessage requests.
(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');

  function button(cls, text) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    return b;
  }

  function render(projects, selected) {
    const frag = document.createDocumentFragment();
    for (const p of projects) {
      const sec = document.createElement('section');
      const header = Object.assign(document.createElement('div'), { className: 'project-row' });
      const head = button('project', p.name);
      head.dataset.key = p.key;
      head.setAttribute('aria-expanded', String(!p.collapsed));
      head.appendChild(Object.assign(document.createElement('span'), { className: 'chevron' + (p.collapsed ? ' closed' : '') }));
      const plus = button('plus', '+');
      plus.dataset.newIn = p.key;
      plus.title = 'New Claude Code session in ' + p.name;
      plus.setAttribute('aria-label', plus.title);
      header.append(head, plus);
      sec.appendChild(header);
      if (!p.collapsed) {
        for (const c of p.chats) {
          const row = button('chat' + (c.id === selected ? ' selected' : ''), '');
          row.dataset.id = c.id;
          row.title = c.title;
          // Right-click menu (package.json webview/context) reads these keys; values are booleans and a UUID.
          row.dataset.vscodeContext = JSON.stringify({ webviewSection: 'session', sessionId: c.id, unread: c.unread, preventDefaultContextMenuItems: true });
          row.appendChild(Object.assign(document.createElement('span'), { className: 'title', textContent: c.title }));
          if (c.status !== 'idle') {
            const dot = Object.assign(document.createElement('span'), { className: 'dot ' + c.status });
            dot.setAttribute('aria-label', c.status === 'unread' ? 'unread' : 'running');
            row.appendChild(dot);
          }
          sec.appendChild(row);
        }
        if (p.more > 0) {
          const more = button('more', 'Show more');
          more.dataset.more = p.key;
          sec.appendChild(more);
        }
      }
      frag.appendChild(sec);
    }
    if (!projects.length) frag.appendChild(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No Claude Code sessions found' }));
    // Keep focus on the same row across repaints.
    const focused = document.activeElement && (document.activeElement.dataset.id || document.activeElement.dataset.key || document.activeElement.dataset.more);
    list.replaceChildren(frag);
    if (focused) {
      const again = [...list.querySelectorAll('button')].find((b) => b.dataset.id === focused || b.dataset.key === focused || b.dataset.more === focused);
      if (again) again.focus();
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.data.type !== 'model') return;
    render(ev.data.projects, ev.data.selected);
  });

  list.addEventListener('click', (e) => {
    const b = e.target instanceof Element && e.target.closest('button');
    if (!b) return;
    if (b.dataset.newIn) vscode.postMessage({ type: 'newChat', key: b.dataset.newIn });
    else if (b.dataset.id) vscode.postMessage({ type: 'open', id: b.dataset.id });
    else if (b.dataset.key) vscode.postMessage({ type: 'toggle', key: b.dataset.key });
    else if (b.dataset.more) vscode.postMessage({ type: 'more', key: b.dataset.more });
  });

  document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));

  document.getElementById('search').addEventListener('click', () => vscode.postMessage({ type: 'search' }));

  vscode.postMessage({ type: 'ready' });
})();
