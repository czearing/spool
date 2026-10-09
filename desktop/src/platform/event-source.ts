import { appFetch } from "./request";

export class AppEventSource extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  private controller = new AbortController();
  private closed = false;
  constructor(private url: string) { super(); void this.connect(); }
  close() { this.closed = true; this.controller.abort(); }
  private async connect() {
    while (!this.closed) {
      try {
        const response = await appFetch(this.url, { headers: { accept: "text/event-stream" }, signal: this.controller.signal });
        if (!response.ok || !response.body) throw new Error("Event stream unavailable.");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        while (!this.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value.replaceAll("\r\n", "\n");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const lines = buffer.slice(0, end).split("\n"); buffer = buffer.slice(end + 2);
            const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const type = lines.find(line => line.startsWith("event:"))?.slice(6).trim() || "message";
            const event = new MessageEvent(type, { data });
            if (type === "message") this.onmessage?.(event);
            this.dispatchEvent(event);
          }
        }
        if (!this.closed) throw new Error("Event stream closed.");
      } catch (error) { if (!this.closed) { console.error("Live connection failed.", error); this.onerror?.(); } }
      if (!this.closed) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
