import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const theme = read("../app/theme.css");
const plan = read("../../TYPOGRAPHY-PLAN.md");
const fonts = read("../app/fonts.css");

it("implements the specified type tokens without introducing reserved sizes", () => {
  const tokens = {
    "font-size-body": "0.875rem", "font-size-meta": "0.75rem", "line-height": "1.5",
    "font-weight-normal": "400", "font-weight-medium": "500", "font-weight-strong": "600",
  };
  for (const [name, value] of Object.entries(tokens)) {
    expect(theme.match(new RegExp(`--${name}: ([^;]+);`))?.[1].replace(/^\./, "0.")).toBe(value);
    expect(plan).toContain(`\`--${name}\` | \`${value}\``);
  }
  expect(theme).toContain('--font-sans: "Geist Sans", "Geist Fallback",');
  expect(theme).not.toMatch(/--font-size-(reading|title):|--line-height-heading:/);
  const text = read("../components/ui/text.module.css");
  for (const name of Object.keys(tokens)) expect(text).toContain(`var(--${name})`);
  expect(text).not.toMatch(/#[0-9a-f]+|font-weight:\s*\d/i);
});

it("ships the verified variable font under budget with its license", () => {
  const font = readFileSync(new URL("../../public/fonts/geist-sans-1.7.2-400-600.woff2", import.meta.url));
  expect(font.subarray(0, 4).toString()).toBe("wOF2");
  expect(font.byteLength).toBeLessThanOrEqual(60 * 1024);
  expect(font.readUInt32BE(8)).toBe(font.byteLength);
  expect(font.byteLength).toBe(47740);
  const hash = createHash("sha256").update(font).digest("hex");
  expect(hash).toBe("22eaa7ce5601c2295655b9f7a0fa6e14fba534610561319c3c4c19d19219d7a0");
  expect(plan).toContain(hash);
  expect(read("../../public/fonts/LICENSE-Geist.txt")).toContain("SIL OPEN FONT LICENSE Version 1.1");
});

it("shares one same-origin font with real weights, swap, and local metric fallbacks", () => {
  expect([...fonts.matchAll(/url\(/g)]).toHaveLength(1);
  expect(fonts).toContain('url("/fonts/geist-sans-1.7.2-400-600.woff2")');
  expect(fonts).toContain("font-weight: 400 600;");
  expect(fonts).toContain("font-display: swap;");
  expect(fonts.match(/size-adjust:/g)).toHaveLength(3);
  expect(fonts.match(/ascent-override:/g)).toHaveLength(3);
  expect(fonts).not.toMatch(/https?:/);
  expect(read("../app/globals.css")).toContain('@import "./fonts.css"');
  expect(read("../../.storybook/main.ts")).toContain('staticDirs: ["../public"]');
});
