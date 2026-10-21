import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { RunnerSidebar } from "./runner-sidebar";
import { NavigationGuard } from "./navigation-guard";

const state = vi.hoisted(() => ({ running: true, unavailable: false }));
vi.mock("../platform/navigation", () => ({ usePathname: () => "/fixture/runners/livesite", useRouter: () => ({ push: () => {} }) }));
vi.mock("./runner-live-provider", () => ({ useRunnerLive: () => ({
  data: { configured: true, runners: [{ id: "livesite" }, { id: "pr-updater" }] }, error: null, refetch: () => {},
  status: { data: { runners: [{ id: "livesite", running: state.running }] },
    error: state.unavailable ? new Error("Runner status is unavailable.") : null, refetch: async () => {} },
}) }));
beforeEach(() => { state.running = true; state.unavailable = false; });
const render = () => renderToStaticMarkup(createElement(NavigationGuard, { children: createElement(RunnerSidebar, { project: "fixture" }) }));
it("reuses the agent activity badge for the group and running processes, not merely configured runners", () => {
  const html = render();
  expect(html).toContain('aria-label="Runners: 1 active session"');
  expect(html).toContain('aria-label="livesite: 1 active session"');
  expect(html).not.toContain('aria-label="pr-updater: 1 active session"');
  expect(html).toContain('data-pulse="true"');
});
it("does not show stopped processes or stale status as active", () => {
  state.running = false;
  expect(render()).not.toContain("active session");
  state.running = true; state.unavailable = true;
  const html = render();
  expect(html).not.toContain("active session");
  expect(html).toContain('role="alert"');
  expect(html).toContain("Runner status is unavailable.");
});
