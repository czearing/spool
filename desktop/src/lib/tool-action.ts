const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const text = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 500) : "";
const target = (value: unknown) => text(value).split(/[\\/]/).filter(Boolean).slice(-3).join("\\");

export function toolAction(name: string, data: Record<string, unknown>) {
  const args = record(data.arguments) ? data.arguments : {};
  const description = text(args.description);
  if (description) return description;
  if (name === "view" && text(args.path)) return `Read ${target(args.path)}`;
  if (name === "glob" && text(args.pattern)) return `Find files matching ${text(args.pattern)}`;
  if (["rg", "grep"].includes(name) && text(args.glob)) return `Search file contents in ${text(args.glob)}`;
  if (name === "read_powershell" && text(args.shellId)) return `Read output from ${text(args.shellId)}`;
  if (text(args.action)) return text(args.action);
  const title = text(data.toolTitle);
  return title && title !== name && title !== "Running command" ? title : "Description not recorded";
}
