import { describe, expect, it } from "vitest";
import { isSafeBranch, isSafeRepoUrl } from "@/lib/repo-url-validator";

describe("isSafeRepoUrl", () => {
  it.each([
    ["https://github.com/foo/bar.git", true],
    ["http://gitlab.example.com/foo/bar", true],
    ["ssh://git@github.com/foo/bar.git", true],
    ["git@github.com:foo/bar.git", true],
    ["git@bitbucket.org:team/repo", true],
  ])("accepts safe url %s", (url, expected) => {
    expect(isSafeRepoUrl(url)).toBe(expected);
  });

  it.each([
    // shell metacharacters
    ["https://example.com/x; rm -rf $HOME", false],
    ["https://example.com/x`whoami`", false],
    ["https://example.com/x$(whoami)", false],
    ["https://example.com/x|cat /etc/passwd", false],
    ["https://example.com/x && curl evil.com", false],
    // newlines / quotes
    ["https://example.com\nrm -rf .", false],
    ["https://example.com/'$IFS'evil", false],
    // disallowed schemes
    ["file:///etc/passwd", false],
    ["javascript:alert(1)", false],
    // empty / malformed
    ["", false],
    ["not a url", false],
    ["http://", false],
  ])("rejects unsafe url %s", (url) => {
    expect(isSafeRepoUrl(url)).toBe(false);
  });
});

describe("isSafeBranch", () => {
  it.each([
    ["main", true],
    ["feature/foo-bar", true],
    ["v0.1.34", true],
    ["release_2026.05", true],
    ["ISS-115_clean-up", true],
  ])("accepts safe branch %s", (name) => {
    expect(isSafeBranch(name)).toBe(true);
  });

  it.each([
    ["-flag", false],        // leading dash = could be parsed as CLI flag
    ["main; rm -rf .", false],
    ["main$IFS$1", false],
    ["main\nrm", false],
    ["main with space", false],
    ["main'quoted'", false],
    ["", false],
  ])("rejects unsafe branch %s", (name) => {
    expect(isSafeBranch(name)).toBe(false);
  });
});
