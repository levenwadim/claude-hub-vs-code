// Webview script. Renders HTML produced by the extension (markdown-it with html:false, so chat content is escaped).
// All actions are postMessage requests; the extension validates them.
(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const top = document.getElementById('top');
  const primary = document.getElementById('primary');
  const note = document.getElementById('note');
  const BRANCH = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-3.2 2.2-6.2 4.2"/></g></svg>';
  const OPEN_OUT = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Icon from static markup above (never from chat content).
  function icon(svg) {
    const s = document.createElement('span');
    s.className = 'icon';
    s.innerHTML = svg;
    return s;
  }

  let hasMore = false;
  let loading = false;

  function el(item) {
    const d = document.createElement('section');
    d.className = 'msg ' + item.kind;
    d.dataset.off = String(item.off);
    // User text sits in its own bordered box; the time goes outside it.
    d.innerHTML = item.kind === 'user' ? '<div class="bubble">' + item.html + '</div>' : item.html;
    // Time above user/assistant text (as in Claude Code); parsed by Date, shown via textContent.
    const t = item.ts && (item.kind === 'user' || item.kind === 'assistant') ? new Date(item.ts) : undefined;
    if (t && !isNaN(t)) {
      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      d.prepend(time);
    }
    return d;
  }

  // Move each OUT row into the call it answers (matched by tool_use_id). Unmatched ones stay standalone until
  // their call is loaded (older pages arrive later). Only needed when the new items include a call or a result.
  function link(items) {
    if (!items.some((i) => i.kind === 'tool' || i.kind === 'result')) return;
    const calls = new Map();
    for (const c of log.querySelectorAll('.tool-call[data-tool]')) calls.set(c.dataset.tool, c);
    for (const out of log.querySelectorAll('.msg.result .io.out[data-for]')) {
      const call = calls.get(out.dataset.for);
      if (!call) continue;
      const holder = out.closest('.msg.result');
      call.appendChild(out);
      if (!holder.querySelector('.io')) holder.remove();
    }
  }

  function atBottom() {
    return window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  }

  function setTop() {
    top.textContent = hasMore ? 'Loading older messages…' : 'Beginning of conversation';
  }

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && hasMore && !loading) {
      loading = true;
      vscode.postMessage({ type: 'loadMore' });
    }
  });
  io.observe(top);

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'page': {
        loading = false;
        hasMore = m.hasMore;
        if (m.reset) {
          while (top.nextSibling) top.nextSibling.remove();
          const frag = document.createDocumentFragment();
          m.items.forEach((i) => frag.appendChild(el(i)));
          log.appendChild(frag);
          link(m.items);
          window.scrollTo(0, document.body.scrollHeight);
        } else {
          const before = document.body.scrollHeight - window.scrollY;
          const frag = document.createDocumentFragment();
          m.items.forEach((i) => frag.appendChild(el(i)));
          top.after(frag);
          link(m.items);
          window.scrollTo(0, document.body.scrollHeight - before);
        }
        setTop();
        // Page did not fill the screen: keep loading.
        if (hasMore && document.body.scrollHeight <= window.innerHeight) {
          loading = true;
          vscode.postMessage({ type: 'loadMore' });
        }
        break;
      }
      case 'append': {
        const stick = atBottom();
        m.items.forEach((i) => log.appendChild(el(i)));
        link(m.items);
        if (stick) window.scrollTo(0, document.body.scrollHeight);
        break;
      }
      case 'replace': {
        // Full text of a truncated record. Tool rows are replaced in place (they may have moved into their call's card).
        const fresh = document.createElement('div');
        fresh.innerHTML = m.item.html;
        const rows = fresh.querySelectorAll('.io[data-key]');
        for (const row of rows) {
          const cur = [...log.querySelectorAll('.io[data-key]')].find((e) => e.dataset.key === row.dataset.key);
          row.classList.add('open');
          cur?.replaceWith(row);
        }
        if (!rows.length) log.querySelector('section[data-off="' + Number(m.item.off) + '"]')?.replaceWith(el(m.item));
        break;
      }
      case 'button': {
        const s = m.state;
        const away = s.kind !== 'open'; // another folder: Claude Code can only resume it in a window of that folder
        note.title = m.cwd;
        primary.disabled = s.kind === 'missing';
        primary.replaceChildren(away ? (m.newWindow ? 'Open new window' : 'Open project') : (m.terminal ? 'Open session in terminal' : 'Open session'));
        if (away && m.newWindow) primary.append(icon(OPEN_OUT));
        note.replaceChildren();
        if (m.worktree) note.append(icon(BRANCH), m.worktree);
        break;
      }
      case 'error':
        loading = false;
        top.textContent = 'Error: ' + m.text;
        break;
    }
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const io = t.closest('.io');
    if (io && !t.classList.contains('full')) io.classList.toggle('open');
    if (t.id === 'primary') vscode.postMessage({ type: 'primary' });
    else if (t.classList.contains('full')) {
      t.disabled = true;
      vscode.postMessage({ type: 'full', off: Number(t.dataset.off) });
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
