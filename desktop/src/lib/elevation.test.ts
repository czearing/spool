import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const directory = new URL("../components/ui/", import.meta.url);
const elevation = readFileSync(new URL("../app/elevation.css", import.meta.url), "utf8");

it("keeps every component shadow application in the shared surface module", () => {
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".css"))) {
    const css = readFileSync(new URL(file, directory), "utf8");
    expect(css).not.toContain("drop-shadow(");
    if (file !== "surface.module.css") expect(css, file).not.toMatch(/box-shadow:/);
    else {
      const declarations = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map((match) => match[1]);
      expect(declarations).toEqual(["var(--shadow-floating)", "var(--shadow-dialog)", "var(--shadow-toast)", "var(--shadow-tooltip)", "var(--shadow-board-card)"]);
    }
  }
});

it("maps overlays onto three global theme-aware tiers with high-contrast opt-out", () => {
  for (const [surface, tier] of [["floating", "medium"], ["toast", "medium"], ["dialog", "large"], ["tooltip", "small"]]) {
    expect(elevation).toContain(`--shadow-${surface}: var(--shadow-${tier});`);
  }
  expect(elevation).toContain("--shadow-none: none;");
  expect(elevation).toContain("--shadow-board-card: var(--shadow-hairline);");
  expect(elevation).toContain("--shadow-hairline: var(--shadow-none);");
  expect(elevation).toContain("@media (forced-colors: active)");
  for (const tier of ["small", "medium", "large"]) expect(elevation).toContain(`--shadow-${tier}: var(--shadow-none);`);
  expect(elevation.match(/light-dark\(/g)).toHaveLength(2);
});
