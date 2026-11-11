/** Minimal slice of vscode.Memento, so this module stays testable without VS Code. */
export interface Store {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const READ_KEY = 'claudeHub.readAt';
const BASELINE_KEY = 'claudeHub.readBaseline';
const FORCED = 0; // "Mark as unread": stays unread until the session is opened or marked read

/**
 * Hub's own read state (the desktop app keeps its unread flags in private storage).
 * A session is unread when it has a message newer than when you last saw it. Sessions that existed
 * before Hub was installed count as read.
 */
export class ReadState {
  private store: Store;
  private baseline: number;

  constructor(store: Store, now = Date.now()) {
    this.store = store;
    const b = store.get<number>(BASELINE_KEY);
    this.baseline = b ?? now;
    if (b === undefined) store.update(BASELINE_KEY, now);
  }

  // Read on every call, not cached: another VS Code window may have changed it.
  private get map(): Record<string, number> { return this.store.get<Record<string, number>>(READ_KEY) ?? {}; }

  isUnread(id: string, activity: number): boolean {
    const r = this.map[id];
    return r === FORCED || activity > (r ?? this.baseline);
  }

  markRead(id: string, at = Date.now()) { this.set(id, at); }

  markUnread(id: string) { this.set(id, FORCED); }

  /** The session is on screen: whatever it wrote so far is seen. A forced "unread" is kept. */
  seen(id: string, activity: number) {
    const r = this.map[id];
    if (r !== FORCED && activity > (r ?? this.baseline)) this.set(id, activity);
  }

  private set(id: string, v: number) {
    this.store.update(READ_KEY, { ...this.map, [id]: v });
  }
}
