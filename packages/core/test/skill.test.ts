import { describe, expect, it } from "vitest";
import { parseSkillDocument, SkillParseError, splitSkillDocument } from "../src/skill.js";

const valid = `---
name: release-helper
description: Prepare a bounded release summary.
license: MIT
compatibility: Requires git.
allowed-tools: git status
metadata:
  harnest-tools: '["git.status", "git.diff"]'
  harnest-connections: repository
  harnest-permissions: process:git, filesystem:read
---
# Release helper

Follow the checklist.
`;

describe("Agent Skill document parser", () => {
  it("parses public frontmatter and namespaced Harnest requirements", () => {
    const parsed = parseSkillDocument(valid, { directoryName: "release-helper" });
    expect(parsed.descriptor).toMatchObject({
      name: "release-helper",
      description: "Prepare a bounded release summary.",
      license: "MIT",
      compatibility: "Requires git.",
      allowedTools: "git status",
      requirements: {
        tools: ["git.status", "git.diff"],
        connections: ["repository"],
        permissions: ["process:git", "filesystem:read"],
      },
    });
    expect(parsed.body).toContain("# Release helper");
  });

  it("supports CRLF delimiters without interpreting Markdown", () => {
    const split = splitSkillDocument("---\r\nname: safe\r\ndescription: Safe.\r\n---\r\n---\r\nbody");
    expect(split.yaml).toContain("name: safe");
    expect(split.body).toBe("---\r\nbody");
  });

  it.each([
    ["missing delimiter", "name: safe\ndescription: Safe", "SKILL_FRONTMATTER_MISSING"],
    ["uppercase name", "---\nname: Not-Safe\ndescription: Safe\n---\n", "SKILL_NAME_INVALID"],
    ["consecutive hyphens", "---\nname: not--safe\ndescription: Safe\n---\n", "SKILL_NAME_INVALID"],
    ["empty description", "---\nname: safe\ndescription: ''\n---\n", "SKILL_DESCRIPTION_INVALID"],
    ["non-string metadata", "---\nname: safe\ndescription: Safe\nmetadata:\n  owner: 42\n---\n", "SKILL_METADATA_INVALID"],
    ["YAML alias", "---\nname: safe\ndescription: Safe\nmetadata: &m\n  x: y\nextra: *m\n---\n", "SKILL_FRONTMATTER_INVALID"],
    ["invalid requirement", "---\nname: safe\ndescription: Safe\nmetadata:\n  harnest-tools: 'bad value'\n---\n", "SKILL_REQUIREMENT_INVALID"],
  ])("rejects %s", (_label, source, code) => {
    expect(() => parseSkillDocument(source)).toThrowError(expect.objectContaining({ code }));
  });

  it("requires the public name to match its containing directory", () => {
    expect(() => parseSkillDocument(valid, { directoryName: "different" }))
      .toThrowError(expect.objectContaining({ code: "SKILL_NAME_MISMATCH" } satisfies Partial<SkillParseError>));
  });
});
