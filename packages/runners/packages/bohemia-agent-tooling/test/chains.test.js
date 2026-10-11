import test from "node:test";
import assert from "node:assert/strict";

import { linkChains, CHAIN_ROOT_KINDS } from "../src/chains.js";

const readers = { idOf: (row) => row.id, parentOf: (row) => row.parentId ?? null };

test("a chain is walked from its root to the row every outcome is read from", () => {
  const rows = [
    { id: "a" },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" },
    { id: "d" },
  ];
  const linked = linkChains(rows, readers);

  assert.equal(linked.chainCount, 2);
  assert.equal(linked.rowsInChains, 4);
  assert.equal(linked.unreachableRows, 0);
  const first = linked.chains[0];
  assert.deepEqual(first.ids, ["a", "b", "c"]);
  assert.equal(first.length, 3);
  assert.equal(first.links, 2);
  assert.equal(first.terminal.id, "c");
  assert.equal(linked.chains[1].terminal.id, "d");
});

test("a row whose parent is outside the read is one chain rather than dropped or counted twice", () => {
  const rows = [{ id: "b", parentId: "a" }, { id: "c", parentId: "b" }];
  const linked = linkChains(rows, readers);

  assert.equal(linked.chainCount, 1);
  assert.equal(linked.originChains, 0);
  assert.equal(linked.detachedChains, 1);
  assert.equal(linked.chains[0].rootKind, CHAIN_ROOT_KINDS.DETACHED);
  assert.equal(linked.chains[0].terminal.id, "c");
  assert.equal(linked.unreachableRows, 0);
});

test("two rows claiming one parent record the branch rather than choosing it silently", () => {
  const rows = [
    { id: "a" },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "a" },
  ];
  const linked = linkChains(rows, readers);

  assert.equal(linked.chainCount, 1);
  assert.equal(linked.branchedChains, 1);
  assert.equal(linked.chains[0].terminal.id, "b");
  assert.equal(linked.unreachableRows, 1);
});

test("a link pointing back into its own chain stops the walk instead of hanging the caller", () => {
  const rows = [
    { id: "a", parentId: "c" },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" },
  ];
  const linked = linkChains(rows, readers);

  assert.equal(linked.chainCount, 0);
  assert.equal(linked.unreachableRows, 3);
});

test("a second row carrying an identity already read is counted rather than walked twice", () => {
  const rows = [{ id: "a" }, { id: "b", parentId: "a" }, { id: "b", parentId: "a" }];
  const linked = linkChains(rows, readers);

  assert.equal(linked.duplicateIds, 1);
  assert.equal(linked.chainCount, 1);
  assert.deepEqual(linked.chains[0].ids, ["a", "b"]);
});

test("a row with no identity is counted rather than walked", () => {
  const linked = linkChains([{ id: null }, { id: "a" }], readers);

  assert.equal(linked.unidentifiedRows, 1);
  assert.equal(linked.chainCount, 1);
});

test("an empty read is an empty chain population and not an error", () => {
  const linked = linkChains([], readers);

  assert.equal(linked.chainCount, 0);
  assert.equal(linked.rowsInChains, 0);
  assert.equal(linked.unreachableRows, 0);
});

test("the walk refuses to guess how a row points at its parent", () => {
  assert.throws(() => linkChains([], {}), /idOf and a parentOf/);
  assert.throws(() => linkChains([], { idOf: (row) => row.id }), /idOf and a parentOf/);
});
