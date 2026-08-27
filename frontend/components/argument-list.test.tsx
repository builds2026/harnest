import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ui/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

import { ArgumentList, removeArgument, replaceArgument } from "./argument-list";

describe("ArgumentList", () => {
  it("preserves exact argument boundaries, including spaces and empty arguments", () => {
    const args = ["--title", "two words", ""];
    expect(replaceArgument(args, 1, "three exact words")).toEqual(["--title", "three exact words", ""]);
    expect(removeArgument(args, 0)).toEqual(["two words", ""]);
  });

  it("renders one input for each argument instead of joining argv", () => {
    const html = renderToStaticMarkup(<ArgumentList id="args" label="Argument" args={["two words", ""]} addLabel="Add argument" removeLabel="Remove argument" onChange={() => undefined} />);
    expect(html.match(/<input/g)).toHaveLength(2);
    expect(html).toContain('value="two words"');
    expect(html).toContain('value=""');
  });
});
