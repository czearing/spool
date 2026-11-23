import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

export const instrumentation = {
    name: "chat-performance-counters", enforce: "pre",
    async transform(code, id) {
      id = id.replaceAll("\\", "/");
      if (id.endsWith("/src/components/task-conversation-thread.tsx") && process.env.SPOOL_CHAT_THREAD_SOURCE)
        code = await readFile(process.env.SPOOL_CHAT_THREAD_SOURCE, "utf8");
      let needle, counter;
      if (id.endsWith("/src/components/task-chat-view.tsx")) { needle = "  const selectItems ="; counter = "view"; }
      else if (id.endsWith("/src/components/task-conversation-thread.tsx")) { needle = "  const viewport ="; counter = "thread"; }
      else if (id.endsWith("/src/components/ui/message-bubble.tsx")) { needle = "  const [copied,"; counter = "bubbles"; }
      else return;
      assert.ok(code.includes(needle), `Instrumentation no longer matches ${id}`);
      let instrumented = code.replace(needle, `  if (globalThis.__chatPerf) globalThis.__chatPerf.${counter}++;\n${needle}`);
      if (counter === "thread") instrumented = instrumented.replace("return <div className={styles.virtualThread}>",
        "if (globalThis.__chatPerf) globalThis.__chatPerf.scrolling = virtual.isScrolling; return <div className={styles.virtualThread}>");
      return { code: instrumented, map: null };
    },
  };

export async function observeChatPerformance(page) {
  await page.addInitScript(() => {
    globalThis.__chatPerf = { view: 0, thread: 0, bubbles: 0, dates: 0, dateMs: 0, parses: 0, longTasks: [], paints: [] };
    const json = Response.prototype.json;
    Response.prototype.json = function (...args) {
      if (this.url.includes("/tasks/one/conversation?")) globalThis.__chatPerf.parses++;
      return json.apply(this, args);
    };
    const original = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = function (...args) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally { globalThis.__chatPerf.dates++; globalThis.__chatPerf.dateMs += performance.now() - start; }
    };
    new PerformanceObserver(list => globalThis.__chatPerf.longTasks.push(...list.getEntries().map(entry => entry.duration)))
      .observe({ type: "longtask", buffered: true });
    document.addEventListener("input", () => {
      const start = performance.now();
      requestAnimationFrame(() => globalThis.__chatPerf.paints.push(performance.now() - start));
    }, true);
  });
}

export function chatMeasurements(page) {
  const reset = () => page.evaluate(() => Object.assign(globalThis.__chatPerf, {
    view: 0, thread: 0, bubbles: 0, dates: 0, dateMs: 0, parses: 0, longTasks: [], paints: [],
  }));
  const sample = () => page.evaluate(() => {
    const data = globalThis.__chatPerf, paints = [...data.paints].sort((a, b) => a - b);
    return { view: data.view, thread: data.thread, bubbles: data.bubbles, dates: data.dates, dateMs: data.dateMs, parses: data.parses,
      longTasks: data.longTasks.length, maxLongTask: Math.max(0, ...data.longTasks),
      totalLongTaskMs: data.longTasks.reduce((sum, duration) => sum + duration, 0),
      typingP95: paints[Math.ceil(paints.length * .95) - 1] ?? 0 };
  });
  return { reset, sample };
}

export async function measureChatScroll({ chat, session, settle, reset, sample }) {
  const scrollElement = await chat.elementHandle();
  assert.ok(scrollElement);
  await reset();
  await session.send("Performance.enable");
  const beforeScroll = Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  const trace = [];
  if (process.env.SPOOL_CHAT_TRACE) {
    session.on("Tracing.dataCollected", event => trace.push(...event.value));
    await session.send("Tracing.start", { categories: "devtools.timeline,toplevel,v8.execute" });
  }
  if (process.env.SPOOL_CHAT_CPU_PROFILE) {
    await session.send("Profiler.enable");
    await session.send("Profiler.start");
  }
  for (let index = 0; index < 12; index++) {
    await scrollElement.evaluate(element => { element.scrollTop = Math.max(0, element.scrollTop - 1400); });
    await settle();
  }
  const afterScroll = Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  const scrolling = { ...await sample(), taskMs: (afterScroll.TaskDuration - beforeScroll.TaskDuration) * 1000,
    scriptMs: (afterScroll.ScriptDuration - beforeScroll.ScriptDuration) * 1000,
    layoutMs: (afterScroll.LayoutDuration - beforeScroll.LayoutDuration) * 1000 };
  await scrollElement.dispose();
  if (process.env.SPOOL_CHAT_TRACE) {
    const complete = new Promise(resolve => session.once("Tracing.tracingComplete", resolve));
    await session.send("Tracing.end"); await complete;
    await writeFile(process.env.SPOOL_CHAT_TRACE, JSON.stringify({ traceEvents: trace }));
  }
  if (process.env.SPOOL_CHAT_CPU_PROFILE) {
    const { profile } = await session.send("Profiler.stop");
    await writeFile(process.env.SPOOL_CHAT_CPU_PROFILE, JSON.stringify(profile));
  }
  return scrolling;
}

export function assertChatMetrics({ idle, streaming, scrolling }, heartbeatError, sends) {
  assert.equal(idle.view, 0, "Unchanged polling must not rerender the chat view.");
  assert.equal(idle.thread, 0, "Unchanged polling must not rerender the virtual conversation.");
  assert.equal(idle.responseBodyBytes, 0, "Unchanged polling must not transfer the same history again.");
  assert.equal(idle.parses, 0, "Unchanged polling must not parse the same history again.");
  assert.ok(idle.notModified >= 2, "Verify that real conditional polling occurred.");
  assert.equal(streaming.dates, 0, "Streaming must not repeat unchanged timestamp locale formatting.");
  assert.ok(scrolling.thread <= 48, "Scrolling must not rerender React for every individual row measurement.");
  assert.ifError(heartbeatError);
  assert.equal(sends, 0, "Reading, scrolling and preserving drafts must never send a message or launch a provider.");
}

export async function assertRowsDoNotOverlap(chat, settle) {
  await settle();
  const boxes = await chat.locator("[data-message-id]").evaluateAll(rows => rows.map(row => {
    const box = row.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  }));
  for (let index = 1; index < boxes.length; index++)
    assert.ok(Math.abs(boxes[index].top - boxes[index - 1].bottom) < 2, "Measured rows must not overlap or leave blank gaps.");
}
