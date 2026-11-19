/**
 * Reads issues off the existing endpoints. No server change and no schema change.
 *
 * The list payload carries the status but not the blocker relation, so a blocked issue is read once
 * more on its own to learn what actually blocks it, what waits on it, and whether it records a way
 * back. Only blocked issues are read again, so the second read is bounded by the number of blocked
 * issues rather than by the board size. A blocker that is not itself blocked is never read again: its
 * entry inside the relation already carries the status, which is all the wake path walk asks of it.
 */
export function createIssuesSource({ baseUrl, apiKey, companyId, fetchImpl = fetch }) {
  if (!baseUrl) throw new Error("issues source requires a base url");
  if (!apiKey) throw new Error("issues source requires an api key");
  if (!companyId) throw new Error("issues source requires a company id");

  const root = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${apiKey}` };

  async function readJson(url, label) {
    const response = await fetchImpl(url, { headers });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${label} read failed with ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    async readBlockedIssues({ limit = 200 } = {}) {
      const payload = await readJson(
        `${root}/api/companies/${companyId}/issues?limit=${limit}`,
        "issues",
      );
      const list = Array.isArray(payload)
        ? payload
        : (payload?.issues ?? payload?.data ?? null);
      if (!Array.isArray(list)) throw new Error("issues returned no array of issues");

      const blocked = list.filter((issue) => issue.status === "blocked");
      const detailed = [];
      for (const issue of blocked) {
        const detail = await readJson(`${root}/api/issues/${issue.id}`, `issue ${issue.id}`);
        const full = detail?.issue ?? detail ?? {};
        detailed.push({
          ...issue,
          ...full,
          status: full.status ?? issue.status ?? null,
          blockedBy: full.blockedBy ?? [],
          blocks: full.blocks ?? [],
          monitorNextCheckAt: full.monitorNextCheckAt ?? issue.monitorNextCheckAt ?? null,
          unblockDescriptor: full.unblockDescriptor ?? issue.unblockDescriptor ?? null,
        });
      }
      return detailed;
    },
  };
}
