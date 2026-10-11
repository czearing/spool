import test from "node:test";
import assert from "node:assert/strict";
import { clusterFiles, getFeatureDirectory } from "../cluster.js";

test("getFeatureDirectory extracts common module directory", () => {
  assert.equal(getFeatureDirectory("apps/new-office/src/data/loki/constants.ts"), "apps/new-office");
  assert.equal(getFeatureDirectory("apps/new-office/src/data/Notebook.ts"), "apps/new-office");
  assert.equal(getFeatureDirectory("apps/new-office/src/fluid/pod.ts"), "apps/new-office");
  assert.equal(getFeatureDirectory("packages/ux/src/Button/Button.tsx"), "packages/ux");
});

test("clusterFiles coalesces files in the same feature folder into a single condensed task", () => {
  const files = [
    {
      path: "apps/new-office/src/data/loki/constants.ts",
      slopLines: 6,
      slopComments: 6,
      codeLines: 46,
      slopDensity: 0.13,
      findings: [{ startLine: 10, endLine: 10, category: "tautology", reasons: ["echo"] }],
    },
    {
      path: "apps/new-office/src/data/loki/getUserChatsQuery.ts",
      slopLines: 1,
      slopComments: 1,
      codeLines: 88,
      slopDensity: 0.011,
      findings: [{ startLine: 5, endLine: 5, category: "tautology", reasons: ["echo"] }],
    },
    {
      path: "apps/new-office/src/data/Notebook.ts",
      slopLines: 1,
      slopComments: 1,
      codeLines: 18,
      slopDensity: 0.055,
      findings: [{ startLine: 2, endLine: 2, category: "structural_noise", reasons: ["banner"] }],
    },
    {
      path: "apps/new-office/src/fluid/pod.ts",
      slopLines: 2,
      slopComments: 2,
      codeLines: 95,
      slopDensity: 0.021,
      findings: [{ startLine: 8, endLine: 8, category: "tautology", reasons: ["echo"] }],
    },
  ];

  const clusters = clusterFiles(files, { maxFilesPerCluster: 8 });
  assert.equal(clusters.length, 1);

  // Cluster: apps/new-office (4 files, 10 slop lines)
  const appCluster = clusters.find((c) => c.directory === "apps/new-office");
  assert.ok(appCluster);
  assert.equal(appCluster.fileCount, 4);
  assert.equal(appCluster.totalSlopLines, 10);
  assert.equal(appCluster.totalSlopComments, 10);
  assert.equal(appCluster.files.length, 4);
  assert.ok(appCluster.reproduction.includes("constants.ts"));
  assert.ok(appCluster.reproduction.includes("getUserChatsQuery.ts"));
  assert.ok(appCluster.reproduction.includes("Notebook.ts"));
  assert.ok(appCluster.reproduction.includes("pod.ts"));
});

test("clusterFiles marks in-flight clusters based on active tasks", () => {
  const files = [
    {
      path: "apps/new-office/src/data/constants.ts",
      slopLines: 4,
      slopComments: 2,
      codeLines: 40,
      slopDensity: 0.1,
      findings: [],
    },
  ];

  const activeTasks = [{ title: "slop: apps/new-office (1 file, 4 slop lines)" }];
  const clusters = clusterFiles(files, { activeTasks });
  assert.equal(clusters[0].isInFlight, true);
});
