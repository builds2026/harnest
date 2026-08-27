import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, safeMarkdownHref } from "./markdown";

describe("safe Markdown", () => {
  it("renders useful formatting without interpreting HTML or unsafe links", () => {
    const html = renderToStaticMarkup(<Markdown>{"## Result\n\n**safe** <script>alert(1)</script> [bad](javascript:alert(1)) [docs](https://example.com)"}</Markdown>);
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>safe</strong>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
  });

  it("allows only explicit web, mail, root-relative, and fragment links", () => {
    expect(safeMarkdownHref(" /runs ")).toBe("/runs");
    expect(safeMarkdownHref("data:text/html,test")).toBeUndefined();
  });
});
