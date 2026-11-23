import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ActiveInstances } from "./active-instances";

it("shows only colored dots and numbers for every sidebar status, preserving accessible labels", () => {
  const html = renderToStaticMarkup(createElement(ActiveInstances, {
    name: "engineer", pending: 2, starting: 3, count: 5,
  }));
  expect(html.replace(/<[^>]+>/g, "")).toBe("235");
  expect(html.match(/data-tone="[^"]+"/g)).toEqual([
    'data-tone="neutral"', 'data-tone="info"', 'data-tone="success"',
  ]);
  for (const label of ["2 pending tasks", "3 starting sessions", "5 active sessions"])
    expect(html).toContain(`aria-label="engineer: ${label}"`);
});

it("omits empty sidebar status indicators", () => {
  expect(renderToStaticMarkup(createElement(ActiveInstances, { name: "engineer", count: 0 }))).toBe("");
});
