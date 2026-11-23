import { expect, it } from "vitest";
import { defaultSettings, parseSettings, themeBootstrap, validModel } from "./settings";

it("preserves the light default and restores versioned browser settings", () => {
  expect(parseSettings(null)).toEqual(defaultSettings);
  for (const theme of ["system", "dark", "light"]) {
    expect(parseSettings(JSON.stringify({ version: 1, theme, defaultModel: "provider/model-v1" })))
      .toEqual({ theme });
  }
});
it.each(["{}", "null", "{", '{"version":2}', '{"version":1,"theme":"purple","defaultModel":""}'])("rejects invalid stored settings %s", (raw) => {
  expect(() => parseSettings(raw)).toThrow();
});
it("ignores old browser model preferences instead of overriding native Spool configuration", () => {
  expect(parseSettings('{"version":1,"theme":"dark","defaultModel":"old-browser-model"}')).toEqual({ theme: "dark" });
});
it("accepts empty or explicit model IDs, but not commands, controls or excessive lengths", () => {
  for (const value of ["", "gpt-5.4", "provider:model/v1"]) expect(validModel(value)).toBe(true);
  for (const value of [null, "a b", "--model", "x;exit", "a\n", "x".repeat(129)]) expect(validModel(value)).toBe(false);
});
it("restores only a recognized theme before hydration, without evaluating stored strings", () => {
  const applied: string[] = [];
  const document = { documentElement: { setAttribute: (_key: string, value: string) => applied.push(value) } };
  const bootstrap = new Function("localStorage", "document", themeBootstrap);
  bootstrap({ getItem: () => '{"version":1,"theme":"dark"}' }, document);
  bootstrap({ getItem: () => '{"version":1,"theme":"invalid"}' }, document);
  expect(applied).toEqual(["dark"]);
});
