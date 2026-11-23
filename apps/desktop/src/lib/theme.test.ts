import { afterEach, expect, it, vi } from "vitest";
import { applyTheme, parseTheme, themes } from "./theme";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(themes)("selects the %s preview through a single root attribute", (theme) => {
  const setAttribute = vi.fn();
  vi.stubGlobal("document", { documentElement: { setAttribute } });
  applyTheme(theme);
  expect(setAttribute).toHaveBeenCalledExactlyOnceWith("data-theme", theme);
  expect(parseTheme(theme)).toBe(theme);
});
it("defaults an unset Storybook global to System", () => {
  expect(parseTheme(undefined)).toBe("system");
  expect(parseTheme(null)).toBe("system");
});
it("reports invalid preview values and uses System", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(parseTheme("purple")).toBe("system");
  expect(warning).toHaveBeenCalledOnce();
});
