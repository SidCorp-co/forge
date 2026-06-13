import { describe, expect, it } from "vitest";
import { changelogTopId, parseChangelog } from "./changelog";

const MIXED = `# Changelog

Preamble text the parser must skip.

## [Unreleased]

## [0.3.0] - 2026-06-11

Organizations arrive: a two-tier permission model.

- Organizations: every project now lives in an org
- New read-only "viewer" project role

## [0.2.11] - 2026-05-31

### Added

- Runner management is now device-centric

### Changed

- Comments are no longer copied into memory
`;

describe("parseChangelog", () => {
  it("parses flat (Claude-Code-style) releases into one untitled section", () => {
    const releases = parseChangelog(MIXED);
    const v030 = releases.find((r) => r.version === "0.3.0");
    expect(v030).toBeTruthy();
    expect(v030?.sections).toHaveLength(1);
    expect(v030?.sections[0]?.title).toBe("");
    expect(v030?.sections[0]?.body).toContain("Organizations arrive");
    expect(v030?.sections[0]?.body).toContain('- New read-only "viewer" project role');
  });

  it("still parses Keep-a-Changelog ### subsections", () => {
    const v0211 = parseChangelog(MIXED).find((r) => r.version === "0.2.11");
    expect(v0211?.sections.map((s) => s.title)).toEqual(["Added", "Changed"]);
    expect(v0211?.sections[0]?.body).toContain("device-centric");
  });

  it("an empty [Unreleased] block has no sections and a stable id", () => {
    const releases = parseChangelog(MIXED);
    const unreleased = releases[0];
    expect(unreleased?.isUnreleased).toBe(true);
    expect(unreleased?.sections).toHaveLength(0);
    expect(unreleased?.id.startsWith("unreleased:")).toBe(true);
    expect(changelogTopId(releases)).toBe(unreleased?.id);
  });

  it("keeps file order (newest first) and skips the preamble", () => {
    const releases = parseChangelog(MIXED);
    expect(releases.map((r) => r.version)).toEqual([null, "0.3.0", "0.2.11"]);
  });
});
