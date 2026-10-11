import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validationFlavor } from "./ci-validation.mjs";

const fixtures = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-validation-flavor-"));
  fixtures.push(root);
  const directory = path.join(root, "azure", "build-pipelines");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "pr-build.yaml"), text);
  return root;
}

test("validation follows the actual unit-test job flavor rather than the unrelated debug job", () => {
  const root = fixture(`
variables:
  BuildConfiguration: debug
jobs:
  - job: CommandScriptTests
    variables:
      BuildConfiguration: debug
  - job: BuildAndUnitTests
    variables:
      BuildConfiguration: release
`);
  expect(validationFlavor(root)).toBe("release");
});

test("validation honors inherited variables and Azure's named-variable list", () => {
  const root = fixture(`
stages:
  - stage: Tests
    variables:
      - name: BuildConfiguration
        value: checked
    jobs:
      - job: BuildAndUnitTests
`);
  expect(validationFlavor(root)).toBe("checked");
});

for (const variables of ["{}", "{ BuildConfiguration: '$(Unknown)' }", "{ BuildConfiguration: 'release & exit 0' }"]) {
  test(`validation refuses unresolved or unsafe flavor ${variables}`, () => {
    const root = fixture(`jobs:\n  - job: BuildAndUnitTests\n    variables: ${variables}\n`);
    expect(() => validationFlavor(root)).toThrow("Cannot determine");
  });
}

test("missing or ambiguous unit jobs cannot silently select a flavor", () => {
  for (const jobs of ["[]", "[{job: BuildAndUnitTests}, {job: BuildAndUnitTests}]"]) {
    const root = fixture(`variables: {BuildConfiguration: release}\njobs: ${jobs}\n`);
    expect(() => validationFlavor(root)).toThrow("Cannot determine");
  }
});
