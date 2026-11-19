/**
 * Reads heartbeat runs off the existing endpoint. No server change and no schema change.
 */
export function createRunsSource({ baseUrl, apiKey, companyId, fetchImpl = fetch }) {
  if (!baseUrl) throw new Error("runs source requires a base url");
  if (!apiKey) throw new Error("runs source requires an api key");
  if (!companyId) throw new Error("runs source requires a company id");

  const root = baseUrl.replace(/\/+$/, "");

  return {
    async readRuns({ limit = 500 } = {}) {
      const response = await fetchImpl(
        `${root}/api/companies/${companyId}/heartbeat-runs?limit=${limit}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`heartbeat-runs read failed with ${response.status}: ${text.slice(0, 300)}`);
      }
      const payload = text ? JSON.parse(text) : [];
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.runs)) return payload.runs;
      if (Array.isArray(payload?.data)) return payload.data;
      throw new Error("heartbeat-runs returned no array of runs");
    },
  };
}
