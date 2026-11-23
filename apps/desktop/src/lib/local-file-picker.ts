import { appFetch } from "../platform/request";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
export async function browseLocalPath(kind: "file" | "folder", signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) throw signal.reason;
  if (isTauri()) {
    const path = await open({ directory: kind === "folder", multiple: false });
    if (signal.aborted) throw signal.reason;
    return path;
  }
  const response = await appFetch(`/api/file-picker?kind=${kind}`, { method: "POST", signal });
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string"
      ? result.error : "Could not open the picker. Enter the path instead.");
  }
  if (!result || typeof result !== "object" || !("path" in result) ||
    (result.path !== null && (typeof result.path !== "string" || !result.path))) {
    throw new Error("The picker returned an invalid path. Try again or enter it instead.");
  }
  return result.path;
}
