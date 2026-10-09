import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentError, readAgentSource } from "./agents";
import { agentHeader } from "./agent-frontmatter";
import { isAgentIcon, isAgentImage } from "./agent-settings";
import { cachedFileReader } from "./file-snapshot";

const readAppearance = cachedFileReader(async ({ root, id }: { root: string; id: string; file: string }) => {
  const header = agentHeader((await readAgentSource(root, id)).source).text;
  const read = (key: string): unknown => {
    const fields = header.split(/\r?\n/).filter((line) => line.split(":")[0].trim() === key);
    if (!fields.length) return null;
    if (fields.length !== 1) throw new AgentError(`Duplicate ${key} in agent ${id}.`);
    const field = fields[0].slice(fields[0].indexOf(":") + 1).trim();
    return field.startsWith('"') ? JSON.parse(field) : field.replace(/^'|'$/g, "");
  };
  const icon = read("icon") ?? "bot", image = read("image");
  if (!isAgentIcon(icon) || !isAgentImage(image)) throw new AgentError(`Invalid appearance in agent ${id}.`);
  if (image) decodeAgentImage(image);
  return { icon, image, imageVersion: image ? createHash("sha256").update(image).digest("hex") : null };
});
export const readAgentAppearance = (root: string, id: string) => readAppearance({ root, id, file: join(root, "agents", `${id}.md`) });
export function decodeAgentImage(image: string) {
  if (!isAgentImage(image)) throw new AgentError("Invalid agent image.");
  const [prefix, encoded] = image.split(","), type = prefix.slice(5, -7);
  const bytes = Buffer.from(encoded, "base64");
  const valid = type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    type === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) :
      bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid || bytes.toString("base64") !== encoded) throw new AgentError("Invalid agent image.");
  return { bytes, type };
}
