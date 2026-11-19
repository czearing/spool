import type { QueryClient } from "@tanstack/react-query";
import { appFetch } from "../platform/request";
import { conversationQuery } from "../lib/conversation-query";
import { preloadAgentPage } from "./preload-agent-page";
import type { PageData } from "./page-data";

export function desktopPageQuery(pathname: string) {
  const project = pathname.split("/")[1] || "";
  return {
    queryKey: ["desktop-page", project, pathname],
    staleTime: 30_000, retry: false, networkMode: "always" as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<PageData | { redirect: string }> => {
      const response = await appFetch(`/api/desktop/page?deferAgentJobs=2&path=${encodeURIComponent(pathname)}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load this page.");
      return result;
    },
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
