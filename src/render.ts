import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

/** Rendered unit sent to the webview. `off`/`len` locate the source line in the .jsonl file. */
export interface Item { off: number; len: number; kind: string; html: string; ts?: string }

const TRUNC_CHARS = 4000;
const TRUNC_LINES = 80;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// html:false — raw HTML in chat content is escaped, never rendered.
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code, lang) {
    try {
      const body = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : escapeHtml(code);
      return `<pre class="hljs"><code>${body}</code></pre>`;
    } catch {
      return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
    }
  },
});
// Never load remote images from chat content.
md.renderer.rules.image = (tokens, idx) => `<span class="muted">[image: ${escapeHtml(tokens[idx].content || tokens[idx].attrGet('src') || '')}]</span>`;

function markdown(s: string): string {
  return md.render(s);
}

function truncate(s: string, full: boolean): { text: string; cut: boolean } {
  if (full) return { text: s, cut: false };
  let t = s.length > TRUNC_CHARS ? s.slice(0, TRUNC_CHARS) : s;
  const lines = t.split('\n');
  if (lines.length > TRUNC_LINES) t = lines.slice(0, TRUNC_LINES).join('\n');
  return { text: t, cut: t.length < s.length };
}

function toText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : JSON.stringify(b))).join('\n');
  return v === undefined ? '' : JSON.stringify(v, null, 2);
}

function pre(s: string, off: number, full: boolean): string {
  const t = truncate(s, full);
  return `<pre>${escapeHtml(t.text)}</pre>` + (t.cut ? `<button class="full" data-off="${off}">Show full (${s.length.toLocaleString('en')} chars)</button>` : '');
}

/** Short human label next to the tool name (not the command itself, which is shown in the IN box). */
function toolArg(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.description ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query;
  return typeof v === 'string' ? ` <span class="arg">${escapeHtml(v.length > 160 ? v.slice(0, 159) + '…' : v)}</span>` : '';
}

/** One IN/OUT row; capped in height and expanded on click (viewer.js). `key` lets "show full" replace it in place. */
function ioRow(label: 'IN' | 'OUT', body: string, id: unknown, cls = ''): string {
  const k = typeof id === 'string' && id ? ` data-key="${label}:${escapeHtml(id)}"` : '';
  return `<div class="io ${label.toLowerCase()}${cls}"${k}><span class="io-label">${label}</span><div class="io-body">${body}</div></div>`;
}

function block(b: any, off: number, full: boolean): string {
  switch (b?.type) {
    case 'text':
      return typeof b.text === 'string' ? markdown(b.text) : '';
    case 'thinking':
      return typeof b.thinking === 'string' && b.thinking.trim()
        ? `<details class="thinking"><summary>Thinking</summary>${markdown(b.thinking)}</details>` : '';
    case 'redacted_thinking':
      return '';
    case 'tool_use':
    {
      const inp = b.input;
      const text = typeof inp?.command === 'string' ? inp.command : JSON.stringify(inp ?? {}, null, 2);
      // viewer.js moves the matching OUT row (data-for = tool_use_id) into this wrapper.
      const id = typeof b.id === 'string' ? ` data-tool="${escapeHtml(b.id)}"` : '';
      return `<div class="tool-call"${id}><div class="tool-head"><span class="name">${escapeHtml(String(b.name ?? '?'))}</span>${toolArg(inp)}</div>${ioRow('IN', pre(text, off, full), b.id)}</div>`;
    }
    case 'tool_result': {
      const s = toText(b.content);
      const row = ioRow('OUT', pre(s, off, full), b.tool_use_id, b.is_error ? ' error' : '');
      return typeof b.tool_use_id === 'string' ? row.replace('<div class="io ', `<div data-for="${escapeHtml(b.tool_use_id)}" class="io `) : row;
    }
    case 'image':
      return '<span class="muted">[image]</span>';
    default:
      return `<div class="unsupported">unsupported block: ${escapeHtml(String(b?.type))}</div>`;
  }
}

/** Render one .jsonl record. Returns undefined for metadata records that are not part of the conversation. */
export function renderRecord(rec: any, off: number, len: number, full = false): Item | undefined {
  if (!rec || typeof rec !== 'object') return;
  const t = rec.type;
  if (t === 'system' && rec.subtype === 'compact_boundary') return { off, len, kind: 'divider', html: '<hr><div class="muted center">conversation compacted</div>' };
  // Only conversation-chain records (they carry `uuid`) are messages; titles, queue ops, request blobs etc. are metadata.
  if (!rec.message || typeof rec.uuid !== 'string') return;
  if (t !== 'user' && t !== 'assistant') {
    return { off, len, kind: 'unsupported', html: `<div class="unsupported">unsupported message: ${escapeHtml(String(t))}</div>` };
  }
  if (rec.isMeta || rec.isSidechain) return;
  const c = rec.message.content;
  let html: string;
  if (typeof c === 'string') {
    html = c.trimStart().startsWith('<') ? pre(c, off, full) : markdown(c);
  } else if (Array.isArray(c)) {
    html = c.map((b) => block(b, off, full)).join('');
  } else {
    html = `<div class="unsupported">unsupported message content</div>`;
  }
  if (!html) return;
  const toolOnly = Array.isArray(c) && c.length > 0 && c.every((b: any) => b?.type === 'tool_result' || b?.type === 'tool_use' || b?.type === 'thinking');
  // Results get no dot of their own: they are drawn as the OUT half of the preceding tool call.
  // Green dot only when the record really calls a tool; thinking-only records keep the grey assistant dot (no time shown).
  const hasToolUse = Array.isArray(c) && c.some((b: any) => b?.type === 'tool_use');
  const resultOnly = Array.isArray(c) && c.length > 0 && c.every((b: any) => b?.type === 'tool_result');
  return { off, len, kind: resultOnly ? 'result' : toolOnly ? (hasToolUse ? 'tool' : 'assistant thinking') : t, html, ts: typeof rec.timestamp === 'string' ? rec.timestamp : undefined };
}
