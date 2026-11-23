import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { space, type Space } from "../components/ui/spacing";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

it("maps every typed spacing key to one shared CSS token", () => {
  const css = read("../app/spacing.css");
  const scale: [Space, number][] = [[0, 0], [1, 4], [2, 8], [3, 12], [4, 16], [6, 24], [8, 32]];
  for (const [key, pixels] of scale) {
    expect(space(key)).toBe(`var(--space-${key})`);
    expect(css.match(new RegExp(`--space-${key}: (\\d+)px;`))?.[1]).toBe(String(pixels));
  }
  expect(css.match(/--space-\d+:/g)).toHaveLength(scale.length);
  expect(css).toContain("--space-page: clamp(var(--space-4), 3vw, var(--space-8));");
  const theme = read("../app/theme.css");
  expect(theme).toContain('@import "./spacing.css"');
  expect(theme).not.toMatch(/--space-\d+:/);
});
it("keeps component layout gaps in Stack and Grid instead of CSS", () => {
  const directory = new URL("../components/", import.meta.url);
  for (const file of readdirSync(directory, { recursive: true }).filter((name): name is string => typeof name === "string" && name.endsWith(".module.css"))) {
    expect(readFileSync(new URL(file.replaceAll("\\", "/"), directory), "utf8"), file).not.toMatch(/\b(?:row-|column-)?gap\s*:/);
  }
});
