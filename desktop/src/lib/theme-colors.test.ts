import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(new URL("../app/theme.css", import.meta.url), "utf8");
const plan = readFileSync(new URL("../../THEME-PLAN.md", import.meta.url), "utf8");
const colors = [...css.matchAll(/--color-([\w-]+): light-dark\((#[\da-f]{6}), (#[\da-f]{6})\)/g)];
const tokens = Object.fromEntries(colors.map(([, name, light, dark]) => [name, [light, dark]]));

function luminance(hex: string) {
  return hex.slice(1).match(/../g)!.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

it("implements all twenty specified color pairs exactly, using only neutral grays", () => {
  const specified = [...plan.matchAll(/\| `--color-([\w-]+)` \| `(#[\dA-F]{6})` \| `(#[\dA-F]{6})`/g)];
  expect(colors).toHaveLength(20);
  expect(specified).toHaveLength(20);
  for (const [, name, light, dark] of specified) {
    expect(tokens[name]).toEqual([light.toLowerCase(), dark.toLowerCase()]);
    for (const value of tokens[name]) expect(new Set(value.slice(1).match(/../g)).size).toBe(1);
  }
});

it.each([0, 1])("meets text and control contrast across every neutral state in theme %s", (theme) => {
  for (const surface of ["canvas", "surface", "surface-subtle", "surface-hover", "surface-pressed"]) {
    for (const text of ["text", "text-secondary", "text-muted"]) {
      expect(contrast(tokens[text][theme], tokens[surface][theme])).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens["border-control"][theme], tokens[surface][theme])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens["focus-ring"][theme], tokens[surface][theme])).toBeGreaterThanOrEqual(3);
  }
  for (const surface of ["action", "action-hover", "action-pressed"]) {
    expect(contrast(tokens["on-action"][theme], tokens[surface][theme])).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast(tokens["on-selection"][theme], tokens.selection[theme])).toBeGreaterThanOrEqual(4.5);
});
