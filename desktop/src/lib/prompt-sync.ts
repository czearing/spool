import type { AgentPrompt } from "./agents";

export type PromptStatus = { phase: "saved" | "waiting" | "saving" | "error"; dirty: boolean; error: string; conflict: boolean };
export class PromptSaveError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const normalize = (value: string) => value.replace(/\r\n?/g, "\n").trimEnd();

export class PromptSync {
  private revision: string;
  private saved: string;
  private read: () => string;
  private current: () => string;
  private replace: (markdown: string) => void = () => {};
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<boolean>;
  private applying = false;
  private listeners = new Set<() => void>();
  private state: PromptStatus = { phase: "saved", dirty: false, error: "", conflict: false };
  epoch = 0;
  constructor(document: AgentPrompt, private save: (input: Pick<AgentPrompt, "prompt" | "revision">) => Promise<AgentPrompt>) {
    this.revision = document.revision; this.saved = normalize(document.prompt);
    this.current = this.read = () => this.saved;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private publish(update: Partial<PromptStatus>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }
  connect(read: () => string, replace: (markdown: string) => void) {
    this.current = this.read = read; this.replace = replace; this.saved = normalize(read());
  }
  changed(read: () => string) {
    this.read = read;
    if (this.applying || (!this.state.dirty && normalize(read()) === this.saved)) return;
    this.publish({ dirty: true, phase: this.state.error ? "error" : this.pending ? "saving" : "waiting" });
    clearTimeout(this.timer);
    if (!this.state.error) this.timer = setTimeout(() => { void this.flush(); }, 500);
  }
  fail(error: Error) {
    clearTimeout(this.timer);
    this.publish({ dirty: true, phase: "error", error: error.message, conflict: error instanceof PromptSaveError && error.status === 409 });
  }
  flush = (): Promise<boolean> => {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (this.state.error) return Promise.resolve(false);
    this.pending = this.write().finally(() => { this.pending = undefined; });
    return this.pending;
  };
  private async write() {
    try {
      while (true) {
        const prompt = normalize(this.read());
        if (prompt === this.saved) { this.publish({ phase: "saved", dirty: false }); return true; }
        this.publish({ phase: "saving", dirty: true });
        const result = await this.save({ prompt, revision: this.revision });
        this.revision = result.revision; this.saved = normalize(result.prompt); this.epoch++;
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }
  retry = () => { this.publish({ error: "", conflict: false }); return this.flush(); };
  observe(document: AgentPrompt, epoch: number) {
    if (epoch !== this.epoch || this.pending || document.revision === this.revision) return;
    const local = normalize(this.read());
    if (local === this.saved) this.accept(document);
    else if (local === normalize(document.prompt)) {
      this.revision = document.revision; this.saved = local;
      this.publish({ dirty: false, phase: "saved", error: "", conflict: false });
    } else this.fail(new PromptSaveError("This prompt changed elsewhere. Your draft is preserved; reload the latest version before continuing.", 409));
  }
  accept(document: AgentPrompt) {
    if (this.pending) return;
    clearTimeout(this.timer);
    this.applying = true;
    try {
      this.replace(document.prompt);
      this.read = this.current; this.saved = normalize(this.read()); this.revision = document.revision; this.epoch++;
      this.publish({ dirty: false, phase: "saved", error: "", conflict: false });
    } finally { this.applying = false; }
  }
  disconnect() { clearTimeout(this.timer); void this.flush(); }
}
