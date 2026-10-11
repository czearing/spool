import fs from "node:fs";
import path from "node:path";
// Shared preflight used before provisioning and expensive preparation stages.

export function isCapacityError(error) {
  return error?.code === "CREATOR_CAPACITY_LOW" || error?.code === "ENOSPC" ||
    /ENOSPC|no space left on device|not enough space on the disk|Checkout preparation held: [\d.]+ GiB available at .+; [\d.]+ GiB required\./i.test(error?.message || "");
}

export function assertPreparationCapacity(config, cwd, statfs = fs.statfsSync) {
  const minimum = config.creatorMinimumFreeGiB;
  if (minimum === undefined) return;
  if (typeof minimum !== "number" || !Number.isFinite(minimum) || minimum <= 0) {
    throw new Error("creatorMinimumFreeGiB must be a positive number");
  }
  let existing = path.resolve(cwd);
  let stats;
  for (;;) {
    try {
      stats = statfs(existing);
      break;
    } catch (error) {
      const parent = path.dirname(existing);
      if (error.code !== "ENOENT" || parent === existing) throw error;
      existing = parent;
    }
  }
  const available = Number(stats.bavail) * Number(stats.bsize) / 1024 ** 3;
  if (!Number.isFinite(available) || available < minimum) {
    const error = new Error(`Checkout preparation held: ${available.toFixed(2)} GiB available at ${existing}; ${minimum} GiB required. Feedback remains pending and will be retried after capacity recovers.`);
    error.code = "CREATOR_CAPACITY_LOW";
    throw error;
  }
}
