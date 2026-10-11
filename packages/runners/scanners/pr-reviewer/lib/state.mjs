import { readFile } from "node:fs/promises";
export { writeRunnerJsonAsync as writeJsonAtomic } from "../../../packages/bohemia-agent-tooling/src/index.js";

export async function readState(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return {
      active: Array.isArray(value.active) ? value.active : [],
      reviewerAssignments: Array.isArray(value.reviewerAssignments) ? value.reviewerAssignments : null,
      ageExemptReviewerAssignments: Array.isArray(value.ageExemptReviewerAssignments)
        ? value.ageExemptReviewerAssignments
        : [],
      revisionObservations: value.revisionObservations && typeof value.revisionObservations === "object"
        ? value.revisionObservations
        : {},
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        active: [],
        reviewerAssignments: null,
        ageExemptReviewerAssignments: [],
        revisionObservations: {},
      };
    }
    throw error;
  }
}
