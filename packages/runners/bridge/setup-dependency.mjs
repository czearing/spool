import { accessToken } from "../scanners/pr-updater/lib/azure-devops.mjs";

export function setupDependency(reason) {
  const match = /Couldn't find any versions for "(@1js\/[a-z0-9][a-z0-9._-]*)" that matches "(\^\d+\.\d+\.\d+)"/.exec(reason || "");
  return match ? { name: match[1], range: match[2] } : null;
}

export async function setupDependencyAvailable(dependency, { fetchImpl = fetch, token = accessToken } = {}) {
  if (!/^@1js\/[a-z0-9][a-z0-9._-]*$/.test(dependency?.name || "") ||
      !/^\^\d+\.\d+\.\d+$/.test(dependency?.range || ""))
    throw new Error("Unsupported stock setup dependency");
  try {
    const response = await fetchImpl(
      `https://pkgs.dev.azure.com/office/Office/_packaging/1JS/npm/registry/${encodeURIComponent(dependency.name)}`, {
        headers: { Authorization: `Basic ${Buffer.from(`AzureDevOps:${token()}`).toString("base64")}`,
          Accept: "application/vnd.npm.install-v1+json", "Cache-Control": "no-cache" },
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
    if (response.status === 404) return false;
    if (!response.ok) return null;
    const metadata = await response.json();
    if (metadata.name !== dependency.name || !metadata.versions || typeof metadata.versions !== "object") return null;
    const minimum = dependency.range.slice(1).split(".").map(Number);
    const maximum = minimum[0] ? [minimum[0] + 1, 0, 0]
      : minimum[1] ? [0, minimum[1] + 1, 0] : [0, 0, minimum[2] + 1];
    const compare = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    return Object.keys(metadata.versions).some(version => {
      if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
      const current = version.split(".").map(Number);
      return compare(current, minimum) >= 0 && compare(current, maximum) < 0;
    });
  } catch {
    return null;
  }
}
