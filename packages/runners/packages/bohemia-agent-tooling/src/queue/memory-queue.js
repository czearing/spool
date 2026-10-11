/**
 * In memory queue. Used by tests and by a dry run of any tool built on this scaffold.
 */
import { buildPark } from "../park.js";

export function createMemoryQueue({ issues = [] } = {}) {
  const store = new Map(issues.map((issue) => [issue.id, issue]));
  const created = [];
  let counter = store.size;

  return {
    created,
    async createIssue(issue) {
      counter += 1;
      const record = { id: `mem-${counter}`, identifier: `MEM-${counter}`, status: "todo", ...issue };
      store.set(record.id, record);
      created.push(record);
      return record;
    },
    async getIssue(issueId) {
      return store.get(issueId) ?? null;
    },
    async getComments(issueId) {
      return store.get(issueId)?.comments ?? [];
    },
    async listIssues() {
      return [...store.values()];
    },
    async updateIssue(issueId, update) {
      const record = store.get(issueId);
      if (!record) return null;
      const updated = { ...record, ...update };
      store.set(issueId, updated);
      return updated;
    },
    async cancelIssue(issueId) {
      return this.updateIssue(issueId, { status: "cancelled" });
    },
    async parkIssue(issueId, park) {
      const built = buildPark(park);
      return this.updateIssue(issueId, {
        ...built.update,
        monitorNextCheckAt: built.monitorNextCheckAt,
      });
    },
  };
}
