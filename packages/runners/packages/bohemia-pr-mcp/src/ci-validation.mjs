import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadYaml } from "./ci-install.mjs";

export function validationFlavor(repoRoot, yaml = loadYaml(repoRoot)) {
  const file = path.join(repoRoot, "azure", "build-pipelines", "pr-build.yaml");
  const document = yaml.parse(fs.readFileSync(file, "utf8"));
  const matches = [];
  function visit(node, inherited = {}) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inherited);
      return;
    }
    const declared = Array.isArray(node.variables)
      ? Object.fromEntries(node.variables.filter(item => item?.name).map(item => [item.name, item.value]))
      : node.variables || {};
    const variables = { ...inherited, ...declared };
    if (node.job === "BuildAndUnitTests") matches.push(variables.BuildConfiguration);
    for (const [key, value] of Object.entries(node)) {
      if (key !== "variables") visit(value, variables);
    }
  }
  visit(document);
  if (matches.length !== 1 || typeof matches[0] !== "string" || !/^[a-zA-Z0-9_-]+$/.test(matches[0])) {
    throw new Error("Cannot determine the literal BuildAndUnitTests BuildConfiguration from pr-build.yaml");
  }
  return matches[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!path.isAbsolute(process.argv[2] || "")) throw new Error("Absolute repoRoot is required");
  console.log(validationFlavor(process.argv[2]));
}
