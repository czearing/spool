import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(new URL("../app/semantic-colors.css", import.meta.url), "utf8");
const colors = Object.fromEntries([...css.matchAll(/--color-([\w-]+): light-dark\((#[\da-f]{6}), (#[\da-f]{6})\)/g)]
  .map(([, key, light, dark]) => [key, [light, dark]]));
const luminance = (color: string) => color.slice(1).match(/../g)!.map((hex) => {
  const value = parseInt(hex, 16) / 255;
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
}).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
it.each([0, 1])("semantic labels meet normal-text contrast in theme %s", (theme) => {
  for (const tone of ["info", "success", "warning", "danger"]) {
    const pair = [luminance(colors[`${tone}-text`][theme]), luminance(colors[`${tone}-surface`][theme])].sort((a, b) => b - a);
    expect((pair[0] + .05) / (pair[1] + .05)).toBeGreaterThanOrEqual(4.5);
  }
});
it("provides forced-color overrides instead of relying on color for meaning", () => {
  expect(css).toContain("@media (forced-colors: active)");
  for (const tone of ["info", "success", "warning", "danger"]) {
    expect(css).toContain(`--color-${tone}-text: CanvasText`);
    expect(css).toContain(`--color-${tone}-surface: Canvas`);
  }
});
