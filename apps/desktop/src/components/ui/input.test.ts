import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Search } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Input } from "./input";

describe("input adornments", () => {
  it("keeps the input's label, value, and end action with a decorative leading icon", () => {
    const html = renderToStaticMarkup(createElement(Input, { label: "Search nodes", defaultValue: "HTTP",
      leadingIcon: createElement(Search), endAction: createElement("button", null, "Clear") }));
    expect(html).toContain("Search nodes");
    expect(html).toContain('value="HTTP"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">Clear</button>");
  });
  it("does not add an adornment wrapper to existing inputs", () => {
    const html = renderToStaticMarkup(createElement(Input, { label: "Name", required: true, readOnly: true }));
    expect(html).not.toContain("adornedControl");
    expect(html).toMatch(/readonly=""/i);
    expect(html).toContain('required=""');
  });
});
