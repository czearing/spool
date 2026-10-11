import test from "node:test";
import assert from "node:assert/strict";

import {
  makeSpan,
  spanOfInstants,
  isWithinSpan,
  intersectSpans,
  uncoveredSpans,
  describeSpan,
} from "../src/spans.js";

test("a span is built from two instants and normalized to UTC strings", () => {
  const span = makeSpan("2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z");
  assert.deepEqual(span, { from: "2026-09-01T10:00:00.000Z", to: "2026-09-01T12:00:00.000Z" });
});

test("either end may be unbounded", () => {
  assert.deepEqual(makeSpan(null, "2026-09-01T12:00:00Z"), {
    from: null,
    to: "2026-09-01T12:00:00.000Z",
  });
  assert.deepEqual(makeSpan("2026-09-01T10:00:00Z"), {
    from: "2026-09-01T10:00:00.000Z",
    to: null,
  });
  assert.deepEqual(makeSpan(), { from: null, to: null });
});

test("a span that ends before it starts is refused rather than silently reordered", () => {
  assert.throws(
    () => makeSpan("2026-09-01T12:00:00Z", "2026-09-01T10:00:00Z"),
    /cannot end before it starts/,
  );
});

test("the span of a set of instants is its earliest and its latest, and undated values are counted", () => {
  const result = spanOfInstants([
    "2026-09-01T12:00:00Z",
    null,
    "2026-09-01T10:00:00Z",
    undefined,
    "2026-09-01T11:00:00Z",
  ]);
  assert.deepEqual(result.span, {
    from: "2026-09-01T10:00:00.000Z",
    to: "2026-09-01T12:00:00.000Z",
  });
  assert.equal(result.dated, 3);
  assert.equal(result.undated, 2);
});

test("a set that dated nothing has no span and says so rather than returning an empty one", () => {
  const result = spanOfInstants([null, "not-an-instant"]);
  assert.equal(result.span, null);
  assert.equal(result.dated, 0);
  assert.equal(result.undated, 2);
});

test("spanOfInstants refuses a value that is not an array", () => {
  assert.throws(() => spanOfInstants("2026-09-01T10:00:00Z"), /array/);
});

test("both ends of a span are inclusive and an unusable value is outside it", () => {
  const span = makeSpan("2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z");
  assert.equal(isWithinSpan("2026-09-01T10:00:00Z", span), true);
  assert.equal(isWithinSpan("2026-09-01T12:00:00Z", span), true);
  assert.equal(isWithinSpan("2026-09-01T09:59:59Z", span), false);
  assert.equal(isWithinSpan("2026-09-01T12:00:01Z", span), false);
  assert.equal(isWithinSpan(null, span), false);
  assert.equal(isWithinSpan("2026-09-01T09:00:00Z", null), true, "no span bounds nothing");
});

test("the intersection of two spans is the stretch they share", () => {
  const left = makeSpan("2026-09-01T10:00:00Z", "2026-09-01T14:00:00Z");
  const right = makeSpan("2026-09-01T12:00:00Z", "2026-09-01T16:00:00Z");
  assert.deepEqual(intersectSpans(left, right), {
    from: "2026-09-01T12:00:00.000Z",
    to: "2026-09-01T14:00:00.000Z",
  });
});

test("two spans that share nothing intersect to null rather than to an inverted span", () => {
  const before = makeSpan("2026-09-01T10:00:00Z", "2026-09-01T11:00:00Z");
  const after = makeSpan("2026-09-01T12:00:00Z", "2026-09-01T13:00:00Z");
  assert.equal(intersectSpans(before, after), null);
});

test("intersecting with nothing returns the other span, because a null span is unbounded", () => {
  const span = makeSpan("2026-09-01T10:00:00Z", "2026-09-01T11:00:00Z");
  assert.deepEqual(intersectSpans(span, null), span);
  assert.deepEqual(intersectSpans(null, span), span);
  assert.equal(intersectSpans(null, null), null);
});

test("the uncovered parts of a span name both the stretch before coverage and the stretch after it", () => {
  const span = makeSpan("2026-09-01T10:00:00Z", "2026-09-01T16:00:00Z");
  const coverage = makeSpan("2026-09-01T12:00:00Z", "2026-09-01T14:00:00Z");
  assert.deepEqual(uncoveredSpans(span, coverage), [
    { from: "2026-09-01T10:00:00.000Z", to: "2026-09-01T12:00:00.000Z" },
    { from: "2026-09-01T14:00:00.000Z", to: "2026-09-01T16:00:00.000Z" },
  ]);
});

test("a span with no coverage at all is uncovered whole, so a record never read is not read as covered", () => {
  const span = makeSpan("2026-09-01T10:00:00Z", "2026-09-01T16:00:00Z");
  assert.deepEqual(uncoveredSpans(span, null), [span]);
  assert.deepEqual(uncoveredSpans(null, span), []);
});

test("a span fully inside its coverage has no uncovered parts", () => {
  const span = makeSpan("2026-09-01T12:00:00Z", "2026-09-01T13:00:00Z");
  const coverage = makeSpan("2026-09-01T10:00:00Z", "2026-09-01T16:00:00Z");
  assert.deepEqual(uncoveredSpans(span, coverage), []);
});

test("a span reads back as one string, so a refusal can name what it was refused over", () => {
  assert.equal(
    describeSpan(makeSpan("2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z")),
    "2026-09-01T10:00:00.000Z to 2026-09-01T12:00:00.000Z",
  );
  assert.equal(describeSpan(null), "no span");
  assert.equal(
    describeSpan(makeSpan(null, "2026-09-01T12:00:00Z")),
    "the start of the record to 2026-09-01T12:00:00.000Z",
  );
  assert.equal(
    describeSpan(makeSpan("2026-09-01T10:00:00Z", null)),
    "2026-09-01T10:00:00.000Z to the end of the record",
  );
});

test("two readings over the same values return the same span", () => {
  const values = ["2026-09-01T12:00:00Z", "2026-09-01T10:00:00Z"];
  assert.deepEqual(spanOfInstants(values), spanOfInstants(values));
});
