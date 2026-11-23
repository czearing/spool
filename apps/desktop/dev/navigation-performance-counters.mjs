import assert from "node:assert/strict";

export const instrumentation = {
    name: "navigation-performance-counters", enforce: "pre",
    transform(code, id) {
      id = id.replaceAll("\\", "/");
      let needle, measurement;
      if (id.endsWith("/src/components/ui/sidebar.tsx")) {
        needle = "...props }: ItemProps) {";
        measurement = 'if (props.href?.startsWith("/fixture/agents/") && !props["data-work-item-id"]) globalThis.__navigationPerf?.rows.push(props.href);';
      } else if (id.endsWith("/src/components/agent-actions.tsx")) {
        needle = "  const mutation ="; measurement = "if (compact) globalThis.__navigationPerf?.actions.push(agent);";
      } else if (id.endsWith("/src/components/ui/avatar.tsx")) {
        needle = "  return ("; measurement = 'if (name.endsWith(" image")) globalThis.__navigationPerf?.avatars.push(name);';
      } else if (id.endsWith("/src/components/project-switcher.tsx")) {
        needle = "  const [creating,"; measurement = "if (globalThis.__navigationPerf) globalThis.__navigationPerf.switchers++;";
      } else if (id.endsWith("/src/components/navigation-link.tsx")) {
        needle = "  const { navigate }"; measurement = "if (globalThis.__navigationPerf) globalThis.__navigationPerf.links++;";
      } else if (id.endsWith("/src/desktop/app.tsx")) {
        needle = "  useEffect(resumeConversationOutboxes"; measurement = "if (globalThis.__navigationPerf) globalThis.__navigationPerf.pages++;";
      } else if (id.endsWith("/src/components/project-live-provider.tsx")) {
        needle = "const snapshot = parseLive(JSON.parse(event.data));";
        measurement = "if (globalThis.__navigationPerf) globalThis.__navigationPerf.successful = snapshot.successful;";
      } else return;
      assert.ok(code.includes(needle), `Instrumentation no longer matches ${id}`);
      return { code: code.replace(needle, needle.endsWith(";") || needle.endsWith("{") ? `${needle}\n${measurement}` : `${measurement}\n${needle}`), map: null };
    },
  };
