import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const theme = read("../app/theme.css") + read("../app/spacing.css") + read("../app/ui-tokens.css") + read("../app/elevation.css")
  + read("../app/semantic-colors.css") + read("../app/editor-tokens.css");
const files = ["avatar", "checkbox", "divider", "toolbar", "drag", "popover", "command-list", "callout", "collapsible", "sidebar",
  "dialog", "dropdown", "dropdown-button", "menu", "pivot", "field", "toast", "tooltip", "surface", "list", "editor/editor", "editor/editor-content"];

it("defines every design token used by the new component styles", () => {
  const defined = new Set([...theme.matchAll(/(--[\w-]+):/g)].map((match) => match[1]));
  for (const name of files) {
    const css = read(`../components/ui/${name}.module.css`);
    for (const [, token] of css.matchAll(/var\((--(?:color|font|space|size|radius|border|focus|duration|layer|shadow)[\w-]*)/g)) {
      expect(defined.has(token), `${name}: ${token}`).toBe(true);
    }
    expect(css, name).not.toMatch(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(/i);
    expect(css, name).not.toMatch(/(?:font-size|font-weight|padding|gap|border-radius):\s*\d+(?:px|rem)/);
  }
  expect(read("../app/theme.css")).toContain('@import "./ui-tokens.css"');
});

it("keeps interaction state in Radix instead of custom global listeners or timers", () => {
  for (const name of ["avatar", "checkbox", "divider", "toolbar", "popover", "dialog", "dropdown", "dropdown-button", "menu", "pivot", "input", "textarea", "toast", "tooltip", "sidebar"]) {
    const source = read(`../components/ui/${name}.tsx`);
    expect(source, name).not.toMatch(/\b(?:addEventListener|setTimeout|setInterval|useEffect|useState)\s*\(/);
  }
});
