import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { token } from "./ado.ts";

export async function gitCredentials(repoRoot: string, getToken = token) {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  if (!existsSync(repoRoot)) return { environment, redactions: [] as string[] };
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).trim();
  if (!/^https:\/\/(?:dev\.azure\.com\/office\/|office\.visualstudio\.com\/)/i.test(remote)) return { environment, redactions: [] as string[] };
  const credential = await getToken();
  if (!credential) throw new Error("Bohemia could not acquire an Azure DevOps credential");
  const authorization = `Authorization: Basic ${Buffer.from(`PAT:${credential}`).toString("base64")}`;
  const entries = [
    ["credential.helper", ""],
    ["http.https://dev.azure.com/office/.extraHeader", authorization],
    ["http.https://office.visualstudio.com/.extraHeader", authorization],
  ];
  const count = Number(environment.GIT_CONFIG_COUNT || 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid inherited GIT_CONFIG_COUNT");
  environment.GIT_CONFIG_COUNT = String(count + entries.length);
  entries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${count + index}`] = key;
    environment[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
  return { environment, redactions: [credential, authorization, authorization.slice("Authorization: Basic ".length)] };
}
