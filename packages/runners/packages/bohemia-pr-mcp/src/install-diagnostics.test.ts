import { expect, test } from "bun:test";
import { installFailure } from "./install-diagnostics.mjs";

test("pnpm causes precede lifecycle noise without discarding the full install output", () => {
  const source = `CI install step failed\n${"Progress: resolved 100\n".repeat(100)}ERR_PNPM_ENOENT missing package\nDetails`;
  const result = installFailure(new Error(source));
  expect(result.split("\n")[0]).toBe("Error: ERR_PNPM_ENOENT missing package");
  expect(result).toContain(source);
});
test("unrecognized failures retain the actionable tail", () => {
  const result = installFailure(new Error("progress\nTerminated by signal SIGBUS"));
  expect(result).toStartWith("Error: progress\nError: Terminated by signal SIGBUS");
});
