import "./test-environment.ts";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Message = { id?: number; method?: string; result?: { echo?: string } };

async function fixture(run: (send: (data: string | Uint8Array) => void, result: Promise<Message>, messages: Message[]) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-protocol-"));
  // Accelerate only the test clock; run the actual transport and separate worker processes.
  const source = fs.readFileSync(path.join(import.meta.dir, "index.ts"), "utf8");
  expect(source).toContain("}, 15_000)");
  fs.writeFileSync(path.join(root, "index.ts"), source.replace("}, 15_000)", "}, 250)"));
  fs.writeFileSync(path.join(root, "worker.ts"), `
    const request = JSON.parse(await new Response(Bun.stdin.stream()).text());
    if (request.method === "internal/install-progress") {
      await Bun.sleep(2000);
      process.stdout.write(JSON.stringify({ detail: "; fixture slow diagnostics" }));
    } else {
      await Bun.sleep(request.params.arguments.delay || 0);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { echo: request.params.arguments.text } }));
    }
  `);
  const child = Bun.spawn([process.execPath, "run", path.join(root, "index.ts")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const messages: Message[] = [];
  let ready!: () => void, complete!: (message: Message) => void;
  const initialized = new Promise<void>(resolve => { ready = resolve; });
  const result = new Promise<Message>(resolve => { complete = resolve; });
  const stderr = new Response(child.stderr).text();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        messages.push(message);
        if (message.id === 0) ready();
        if (message.id === 1) complete(message);
      }
    }
  })();
  try {
    child.stdin.write('{"jsonrpc":"2.0","id":0,"method":"initialize"}\n');
    await initialized;
    await run(data => { child.stdin.write(data); }, result, messages);
  } finally {
    child.stdin.end();
    await reading;
    expect(await child.exited).toBe(0);
    expect(await stderr).toBe("");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const slowDiagnostics of [false, true]) {
  test(`heartbeats continue ${slowDiagnostics ? "during slow diagnostic reads" : "for PR calls without a checkout argument"}`, async () => {
    await fixture(async (send, result, messages) => {
      send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "bohemia_pr", arguments: { delay: 1200, ...(slowDiagnostics ? { repoRoot: os.tmpdir() } : {}) },
          _meta: { progressToken: "liveness" } } }) + "\n");
      await result;
      expect(messages.filter(message => message.method === "notifications/progress").length).toBeGreaterThanOrEqual(3);
    });
  }, 10000);
}

test("a UTF-8 character split across stdin chunks is preserved exactly", async () => {
  await fixture(async (send, result) => {
    const text = "currency " + String.fromCodePoint(0x20ac);
    const request = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "fixture", arguments: { text } } }) + "\n");
    const split = request.indexOf(Buffer.from(String.fromCodePoint(0x20ac))) + 1;
    send(request.subarray(0, split));
    await Bun.sleep(100);
    send(request.subarray(split));
    expect((await result).result?.echo).toBe(text);
  });
}, 10000);
