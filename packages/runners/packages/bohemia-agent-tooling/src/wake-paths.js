/**
 * Wake path reachability over a dependency graph. Generic: it knows about rows that wait on other
 * rows, not about any one tool.
 *
 * A parked row is not a fault. A parked row with nothing that can ever unpark it is, and the two read
 * the same from the row alone. The difference only appears once the rows it waits on are walked: a row
 * waiting on something live resumes on its own, and a row whose whole waiting closure is itself parked
 * with no timer never resumes at all. Every row pointing at that closure is parked with it, so the
 * cost of one dead end is the size of the population behind it rather than one row.
 *
 * This lives in the core because a queue is a shared surface. Any tool that parks work can strand a
 * chain, and a chain count computed two different ways cannot be compared across tools. What counts as
 * parked, and what counts as a row's own way of waking, stay with the caller: the walk asks and never
 * decides.
 *
 * Nothing here reads the clock and nothing here reads a status, so a walk over unchanged rows returns
 * identical values.
 */

function keyOf(value) {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Walks a dependency graph and reports which parked rows have no way back.
 *
 * `dependsOn` points from a waiting row to the rows it waits on. A row has a wake path when it has one
 * of its own, or when any row in its waiting closure has one. A dependency on a row outside the read
 * is credited as a wake path rather than accused of being a dead end, because absence from the read is
 * not evidence, and the count of those edges is reported so a caller can widen its read. A waiting
 * cycle grants no wake path and is reported rather than left to spin.
 *
 * The three numbers a caller scores are separate on purpose. `deadEnds` are rows parked with nothing
 * to wait on and no timer, which is the row level reading. `chainTerminals` are the dead ends that
 * something else waits on, which is the reading that says the fault is not contained. `stranded` is
 * every parked row whose whole closure is dead, which is the population the fault actually costs.
 */
export function analyzeWakePaths(rows, { idOf, dependsOnOf, isParked, hasOwnWakePath } = {}) {
  if (typeof idOf !== "function") throw new Error("analyzeWakePaths needs an idOf reader");
  if (typeof isParked !== "function") throw new Error("analyzeWakePaths needs an isParked reader");
  if (typeof hasOwnWakePath !== "function") {
    throw new Error("analyzeWakePaths needs a hasOwnWakePath reader");
  }
  const readDependsOn = typeof dependsOnOf === "function" ? dependsOnOf : () => [];

  const byId = new Map();
  for (const row of rows) {
    const id = keyOf(idOf(row));
    if (id === null || byId.has(id)) continue;
    byId.set(id, row);
  }

  const dependsOn = new Map();
  const dependents = new Map();
  let unresolvedDependencies = 0;
  for (const [id, row] of byId) {
    const targets = [];
    for (const raw of readDependsOn(row) ?? []) {
      const targetId = keyOf(raw);
      if (targetId === null || targetId === id) continue;
      if (!byId.has(targetId)) {
        unresolvedDependencies += 1;
        continue;
      }
      if (targets.includes(targetId)) continue;
      targets.push(targetId);
      if (!dependents.has(targetId)) dependents.set(targetId, []);
      dependents.get(targetId).push(id);
    }
    dependsOn.set(id, targets);
  }

  // A dependency on a row outside the read is unknown, not dead, so it counts as a wake path. Rows
  // with such an edge are tracked here so the reachability answer stays honest about what it assumed.
  const hasUnresolvedEdge = new Set();
  for (const [id, row] of byId) {
    const declared = (readDependsOn(row) ?? []).map(keyOf).filter((value) => value !== null && value !== id);
    if (declared.some((targetId) => !byId.has(targetId))) hasUnresolvedEdge.add(id);
  }

  const reaches = new Map();
  const onStack = new Set();
  const cyclicIds = new Set();

  function reachesWakePath(id) {
    if (reaches.has(id)) return reaches.get(id);
    if (onStack.has(id)) {
      cyclicIds.add(id);
      return false;
    }
    onStack.add(id);
    const row = byId.get(id);
    let answer = hasOwnWakePath(row) === true || hasUnresolvedEdge.has(id);
    if (!answer) {
      for (const targetId of dependsOn.get(id) ?? []) {
        if (reachesWakePath(targetId)) {
          answer = true;
          break;
        }
      }
    }
    onStack.delete(id);
    reaches.set(id, answer);
    return answer;
  }

  for (const id of byId.keys()) reachesWakePath(id);

  const parkedIds = [...byId.keys()].filter((id) => isParked(byId.get(id)) === true);
  const strandedIds = parkedIds.filter((id) => reaches.get(id) === false);
  const strandedSet = new Set(strandedIds);

  function dependentsOf(id) {
    const collected = new Set();
    const queue = [...(dependents.get(id) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift();
      if (collected.has(next)) continue;
      collected.add(next);
      for (const further of dependents.get(next) ?? []) queue.push(further);
    }
    return collected;
  }

  const deadEnds = parkedIds
    .filter(
      (id) =>
        hasOwnWakePath(byId.get(id)) !== true && (dependsOn.get(id) ?? []).length === 0 && !hasUnresolvedEdge.has(id),
    )
    .map((id) => {
      const behind = dependentsOf(id);
      const strandedBehind = [...behind].filter((other) => strandedSet.has(other) && other !== id).sort();
      return {
        id,
        row: byId.get(id),
        dependentCount: behind.size,
        strandedDependentIds: strandedBehind,
        strandedDependentCount: strandedBehind.length,
      };
    })
    .sort((a, b) => b.strandedDependentCount - a.strandedDependentCount || a.id.localeCompare(b.id));

  const deadEndSet = new Set(deadEnds.map((entry) => entry.id));
  const chainTerminals = deadEnds.filter((entry) => entry.dependentCount > 0);
  const strandedDependentIds = strandedIds.filter((id) => !deadEndSet.has(id)).sort();

  return {
    rowCount: byId.size,
    parkedCount: parkedIds.length,
    /** Parked rows with nothing to wait on and no wake path of their own. */
    deadEnds,
    deadEndCount: deadEnds.length,
    /** The dead ends something else is waiting on, so the fault reaches past the row it sits on. */
    chainTerminals,
    chainTerminalCount: chainTerminals.length,
    /** Every parked row whose whole waiting closure is dead, dead ends included. */
    strandedIds: strandedIds.slice().sort(),
    strandedCount: strandedIds.length,
    /** The parked rows stranded only because something they wait on is a dead end. */
    strandedDependentIds,
    strandedDependentCount: strandedDependentIds.length,
    /** Edges pointing outside the read, each credited as a wake path rather than accused. */
    unresolvedDependencies,
    /** Rows in a waiting cycle. A non zero count means the graph contradicts itself. */
    cyclicIds: [...cyclicIds].sort(),
  };
}
