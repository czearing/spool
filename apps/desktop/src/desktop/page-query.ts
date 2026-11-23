import type { QueryClient } from "@tanstack/react-query";
import { readJson, readQueryRecovery } from "../platform/read-json";
import { conversationQuery } from "../lib/conversation-query";
import { preloadAgentPage } from "./preload-agent-page";
import type { PageData } from "./page-data";

export function desktopPageQuery(pathname: string) {
  const project = pathname.split("/")[1] || "";
  return {
    queryKey: ["desktop-page", project, pathname],
    staleTime: 30_000, ...readQueryRecovery,
    queryFn: ({ signal }: { signal: AbortSignal }) => readJson<PageData | { redirect: string }>(
      `/api/desktop/page?deferAgentJobs=2&path=${encodeURIComponent(pathname)}`, signal, "Could not load this page."),
  };
}

export async function prefetchDestination(client: QueryClient, href: string) {
  if (!href.startsWith("/") || href.startsWith("//")) return;
  const [pathname, search] = href.split("?");
  const agentRoute = /^\/[^/]+\/agents\/[^/]+$/.test(pathname);
  let project = "";
  if (agentRoute) {
    try { project = decodeURIComponent(pathname.split("/")[1]); }
    catch { return; }
  }
  const operations: Promise<unknown>[] = [client.prefetchQuery(desktopPageQuery(pathname))];
  if (agentRoute) {
    operations.push(preloadAgentPage());
    const task = new URLSearchParams(search).get("task");
    if (task) {
      operations.push(client.prefetchQuery(conversationQuery(project, task)));
    }
  }
  await Promise.all(operations);
}
