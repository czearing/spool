import path from "node:path";

export function runtimeRoot() {
  const root = process.env.SPOOL_RUNNERS_RUNTIME || path.join(import.meta.dirname, "..");
  if (!path.isAbsolute(root)) throw new Error("SPOOL_RUNNERS_RUNTIME must be an absolute directory.");
  return root;
}
