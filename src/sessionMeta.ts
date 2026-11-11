/** Minimal, tolerant parsing of Claude Code session .jsonl files (internal format, may change). */

export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  title?: string;
  /** Generated session name (agent-name record); used only to match Claude Code tab labels. */
  agentName?: string;
  /** Time (ms) of the last user/assistant record. Claude Code also appends bookkeeping records
   *  (cost-state, tools-used…) on reload, so file mtime alone would look like new activity. */
  activity?: number;
}

const TITLE_MAX = 80;

/** Text of a real user prompt, or undefined for meta/tool/command records. */
export function promptText(rec: any): string | undefined {
  if (rec?.type !== 'user' || rec.isMeta || rec.isSidechain || !rec.message) return;
  const c = rec.message.content;
  let text: string | undefined;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: any) => b?.type === 'tool_result')) return;
    text = c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join(' ');
  }
  if (!text) return;
  text = text.trim();
  // Slash-command wrappers, command output, system caveats.
  if (!text || text.startsWith('<') || text.startsWith('Caveat:')) return;
  return text;
}

export function shortTitle(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > TITLE_MAX ? one.slice(0, TITLE_MAX - 1) + '…' : one;
}

function parseLines(text: string, skipFirst: boolean, skipLast: boolean): any[] {
  const lines = text.split('\n');
  if (skipFirst) lines.shift();
  if (skipLast) lines.pop();
  const out: any[] = [];
  for (const l of lines) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial or corrupt line */ }
  }
  return out;
}

/**
 * Extract metadata from the head and tail of a session file.
 * `head` starts at byte 0; `tail` ends at EOF (may start mid-line). `whole` = head covers the whole file.
 * cwd: last `relocated.relocatedCwd`, else first record cwd.
 * Title, same order as Claude Code: last custom-title (/rename), else last ai-title (generated), else first prompt.
 */
export function parseMeta(sessionId: string, head: string, tail: string, whole: boolean): SessionMeta {
  const headRecs = parseLines(head, false, !whole);
  const tailRecs = whole ? [] : parseLines(tail, true, false);
  const meta: SessionMeta = { sessionId };
  let customTitle: string | undefined, aiTitle: string | undefined, relocated: string | undefined, prompt: string | undefined;
  for (const r of [...headRecs, ...tailRecs]) {
    if (!r || typeof r !== 'object') continue;
    if (!meta.cwd && typeof r.cwd === 'string') meta.cwd = r.cwd;
    if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle.trim()) customTitle = r.customTitle;
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim()) aiTitle = r.aiTitle;
    if (r.type === 'agent-name' && typeof r.agentName === 'string') meta.agentName = r.agentName;
    if (r.type === 'relocated' && typeof r.relocatedCwd === 'string') relocated = r.relocatedCwd;
    if (!prompt) prompt = promptText(r);
    if ((r.type === 'user' || r.type === 'assistant') && typeof r.timestamp === 'string') {
      const t = Date.parse(r.timestamp);
      if (t > (meta.activity ?? 0)) meta.activity = t;
    }
  }
  if (relocated) meta.cwd = relocated;
  const t = customTitle ?? aiTitle ?? prompt;
  if (t) meta.title = shortTitle(t);
  return meta;
}
