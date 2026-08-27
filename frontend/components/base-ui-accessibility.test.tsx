import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./i18n-provider", () => ({
  useI18n: () => ({ t: (key: string) => key, formatDate: (value: string) => value }),
}));

import { InteractionRenderer, type InteractionView } from "./interaction-renderer";
import { Field, Input } from "./ui/ui";

describe("Base UI accessibility contracts", () => {
  it("associates stable hint and error messages with the field control", () => {
    const markup = renderToStaticMarkup(<Field label="Name" htmlFor="profile-name" hint="Shown publicly" error="Name is required"><Input /></Field>);

    expect(markup).toContain('id="profile-name"');
    expect(markup).toContain('aria-describedby="profile-name-hint"');
    expect(markup).toContain('aria-errormessage="profile-name-error"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('id="profile-name-hint"');
    expect(markup).toContain('id="profile-name-error"');
  });

  it("renders protocol input as a native form with an explicit submit button", () => {
    const request: InteractionView = {
      id: "clarify",
      runId: "run-1",
      kind: "input",
      title: "Clarify",
      message: "What should change?",
      checkpoint: { digest: "checkpoint-1" },
      schema: { type: "string" },
    };
    const markup = renderToStaticMarkup(<InteractionRenderer request={request} onRespond={() => undefined} />);

    expect(markup).toContain("<form");
    expect(markup).toContain('type="submit"');
    expect(markup).toContain('type="button"');
  });

  it("renders protocol choices with the shared Base UI select", () => {
    const request: InteractionView = {
      id: "priority",
      runId: "run-1",
      kind: "select",
      title: "Priority",
      message: "Choose a priority",
      checkpoint: { digest: "checkpoint-2" },
      schema: { enum: ["low", "high"] },
    };
    const markup = renderToStaticMarkup(<InteractionRenderer request={request} onRespond={() => undefined} />);

    expect(markup).toContain('role="combobox"');
    expect(markup).not.toContain("<select");
  });
});
