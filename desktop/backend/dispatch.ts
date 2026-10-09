import { routes } from "desktop:routes";
import { pageData } from "./page";

export async function dispatch(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/desktop/page" && request.method === "GET") return pageData(request);
  for (const route of routes) {
    const expected = route.path.split("/"), actual = pathname.split("/");
    if (expected.length !== actual.length) continue;
    const params: Record<string, string> = {};
    if (!expected.every((part, index) => {
      if (part.startsWith("[") && part.endsWith("]")) {
        params[part.slice(1, -1)] = decodeURIComponent(actual[index]); return true;
      }
      return part === actual[index];
    })) continue;
    const handler = route.handlers[request.method];
    return handler ? handler(request, { params: Promise.resolve(params) }) : new Response(null, { status: 405 });
  }
  return Response.json({ error: "Unknown desktop operation." }, { status: 404 });
}
