import { pickNativePath, PickerError } from "../../../lib/native-file-picker";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const host = request.headers.get("host");
  const origin = `${new URL(request.url).protocol}//${host}`;
  if (!host || request.headers.get("origin") !== origin ||
    !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
    return Response.json({ error: "Native browsing requires a same-origin localhost request." }, { status: 403 });
  }
  const kind = new URL(request.url).searchParams.get("kind");
  if (kind !== "file" && kind !== "folder") return Response.json({ error: "Choose a file or folder." }, { status: 400 });
  try {
    const path = await pickNativePath(kind, request.signal);
    return Response.json({ path }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PickerError) return Response.json({ error: error.message }, { status: error.status });
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("Unable to open native file picker.", error);
    return Response.json({ error: "Could not open the Windows picker. Check PowerShell 7 is installed, or enter the path instead." }, { status: 500 });
  }
}
