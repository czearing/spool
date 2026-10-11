import test from "node:test";
import assert from "node:assert/strict";
import { defineCollector, runCollection, assertObservation } from "../src/collect.js";

const valid = {
  metric: "demo.metric",
  current: 100,
  target: 50,
  acceptance: 50,
  unit: "bytes",
  reproduction: "node measure.js demo.metric",
};

test("an observation without a finite current number is rejected", () => {
  assert.throws(() => assertObservation({ ...valid, current: null }), /current must be a finite number/);
  assert.throws(() => assertObservation({ ...valid, current: Number.NaN }), /current must be a finite number/);
});

test("an observation without a reproduction command is rejected", () => {
  assert.throws(() => assertObservation({ ...valid, reproduction: "" }), /reproduction must be a non empty string/);
});

test("collection returns validated observations tagged with their collector", async () => {
  const collector = defineCollector({ name: "demo", collect: () => [valid, { ...valid, metric: "demo.other" }] });
  const { observations, failures } = await runCollection([collector]);
  assert.equal(failures.length, 0);
  assert.deepEqual(observations.map((o) => o.metric), ["demo.metric", "demo.other"]);
  assert.equal(observations[0].collector, "demo");
});

test("a collector that throws becomes a failure and produces no observation", async () => {
  const bad = defineCollector({
    name: "broken",
    collect: () => {
      throw new Error("measurement command exited 1");
    },
  });
  const good = defineCollector({ name: "demo", collect: () => valid });
  const { observations, failures } = await runCollection([bad, good]);
  assert.equal(observations.length, 1);
  assert.deepEqual(failures, [{ collector: "broken", error: "measurement command exited 1" }]);
});

test("a collector producing an observation with no number fails instead of leaking a task", async () => {
  const collector = defineCollector({ name: "demo", collect: () => ({ ...valid, current: undefined }) });
  const { observations, failures } = await runCollection([collector]);
  assert.equal(observations.length, 0);
  assert.equal(failures.length, 1);
});

test("defineCollector requires a name and a collect function", () => {
  assert.throws(() => defineCollector({ collect: () => valid }), /requires a name/);
  assert.throws(() => defineCollector({ name: "demo" }), /requires a collect function/);
});

test("collection requires at least one collector", async () => {
  await assert.rejects(() => runCollection([]), /at least one collector/);
});
