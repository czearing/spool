/**
 * Chain linking over parent links. Generic: it knows about rows that point at other rows, not about
 * any one tool.
 *
 * A row that records a parent turns a population of rows into a population of chains, and the two are
 * not the same measurement. Counting rows says how often a single attempt ended badly. Counting chains
 * says how often the work behind those attempts was finished at all, and only the chain answer says
 * whether a policy that retries is giving the work back or dropping it.
 *
 * Every tool with a parent link repeats the same four decisions: what happens to a row whose parent is
 * outside the read, what happens when two rows claim the same parent, what happens when a link points
 * back into its own chain, and which row of a chain is the one an outcome is read from. Answering them
 * once here is what keeps two tools from reporting chain counts that cannot be compared.
 *
 * Nothing here reads the clock and nothing here reads a status, so a chain walk over unchanged rows
 * returns identical values and the meaning of an outcome stays with the caller.
 */

/** How a chain came to be a chain, which is the only thing a caller has to judge differently. */
export const CHAIN_ROOT_KINDS = Object.freeze({
  /** The row records no parent at all, so it is the start of its own work. */
  ORIGIN: "origin",
  /** The row records a parent that was not in the read, so its start is outside the window. */
  DETACHED: "detached",
});

function keyOf(value) {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Walks rows into chains along a parent link.
 *
 * A row with no parent is a root. A row whose parent is missing from the read is also a root, marked
 * detached, so work that began before the window is counted once rather than dropped or double
 * counted through its child. Two rows claiming one parent branch the chain: the walk follows the first
 * child in the caller's order and records the branch rather than picking silently. A link that points
 * back into its own chain stops the walk and marks the chain cyclic, so bad data cannot hang a caller.
 *
 * The terminal row is the last row reached, which is the row every outcome question is asked of.
 */
export function linkChains(rows, { idOf, parentOf } = {}) {
  if (typeof idOf !== "function" || typeof parentOf !== "function") {
    throw new Error("linkChains needs an idOf and a parentOf reader");
  }

  const present = new Map();
  for (const row of rows) {
    const id = keyOf(idOf(row));
    if (id === null || present.has(id)) continue;
    present.set(id, row);
  }

  const children = new Map();
  const roots = [];
  let duplicateIds = 0;
  let unidentifiedRows = 0;
  for (const row of rows) {
    const id = keyOf(idOf(row));
    if (id === null) {
      unidentifiedRows += 1;
      continue;
    }
    if (present.get(id) !== row) {
      duplicateIds += 1;
      continue;
    }
    const parentId = keyOf(parentOf(row));
    if (parentId === null) {
      roots.push({ row, rootKind: CHAIN_ROOT_KINDS.ORIGIN });
      continue;
    }
    if (!present.has(parentId)) {
      roots.push({ row, rootKind: CHAIN_ROOT_KINDS.DETACHED });
      continue;
    }
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(row);
  }

  const chains = roots.map(({ row, rootKind }) => {
    const walked = [row];
    const seen = new Set([keyOf(idOf(row))]);
    let branched = false;
    let current = row;
    for (;;) {
      const next = children.get(keyOf(idOf(current))) ?? [];
      if (next.length === 0) break;
      if (next.length > 1) branched = true;
      const child = next[0];
      const childId = keyOf(idOf(child));
      // A row carries one parent, so a walk cannot revisit a row. The guard is here so link data
      // that contradicts that cannot spin: the rows forming a loop are unreachable from any root
      // and are reported through unreachableRows instead.
      if (seen.has(childId)) break;
      seen.add(childId);
      walked.push(child);
      current = child;
    }
    return {
      rootId: keyOf(idOf(row)),
      rootKind,
      rows: walked,
      ids: walked.map((entry) => keyOf(idOf(entry))),
      root: row,
      terminal: walked[walked.length - 1],
      length: walked.length,
      links: walked.length - 1,
      branched,
    };
  });

  const rowsInChains = chains.reduce((sum, chain) => sum + chain.length, 0);
  return {
    chains,
    chainCount: chains.length,
    rowsInChains,
    originChains: chains.filter((chain) => chain.rootKind === CHAIN_ROOT_KINDS.ORIGIN).length,
    detachedChains: chains.filter((chain) => chain.rootKind === CHAIN_ROOT_KINDS.DETACHED).length,
    branchedChains: chains.filter((chain) => chain.branched).length,
    /** Rows the walk never reached. A non zero count means the link data contradicts itself. */
    unreachableRows: present.size - rowsInChains,
    duplicateIds,
    unidentifiedRows,
  };
}
