import { AgentError } from "./agents";
import { validModel } from "./settings";
import { agentHeader as header } from "./agent-frontmatter";

export function agentModel(source: string): string | null {
  const values = header(source).text.split(/\r?\n/).filter((line) => /^\s*model\s*:/.test(line));
  if (values.length > 1) throw new AgentError("Agent configuration has duplicate model fields.");
  const model = values[0]?.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "") ?? "";
  if (!validModel(model)) throw new AgentError("Agent configuration has an invalid model.");
  return model || null;
}
export function replaceAgentModel(source: string, model: string | null) {
  agentModel(source);
  const { start, end, text } = header(source), newline = source.includes("\r\n") ? "\r\n" : "\n";
  if (end < 0) return model === null ? source : `---${newline}model: ${model}${newline}---${newline}${source}`;
  const clean = text.replace(/^[ \t]*model[ \t]*:[^\r\n]*(?:\r?\n|$)/gm, "");
  const field = model === null ? "" : `${clean.endsWith("\n") ? "" : newline}model: ${model}${newline}`;
  return source.slice(0, start + 3) + clean + field + source.slice(end);
}
