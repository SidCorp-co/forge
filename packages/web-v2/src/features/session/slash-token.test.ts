import { describe, expect, it } from "vitest";
import { filterSkillsByQuery, findSlashToken, replaceSlashToken } from "./slash-token";

describe("findSlashToken", () => {
  it("finds a token that opens the value", () => {
    expect(findSlashToken("/for", 4)).toEqual({ start: 0, end: 4, query: "for" });
  });

  it("finds a bare slash (the menu opens listing everything)", () => {
    expect(findSlashToken("/", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("finds a token that follows whitespace", () => {
    expect(findSlashToken("run /forge", 10)).toEqual({ start: 4, end: 10, query: "forge" });
    expect(findSlashToken("run\n/forge", 10)).toEqual({ start: 4, end: 10, query: "forge" });
  });

  it("ignores a slash glued to a preceding word — prose is not a command", () => {
    expect(findSlashToken("and/or", 6)).toBeNull();
    expect(findSlashToken("see docs/guides", 15)).toBeNull();
    expect(findSlashToken("24/7", 4)).toBeNull();
  });

  it("ends the token at whitespace", () => {
    expect(findSlashToken("/forge-drive now", 16)).toBeNull();
    expect(findSlashToken("/forge-drive ", 13)).toBeNull();
  });

  it("has no token when the caret is before the slash", () => {
    expect(findSlashToken("/forge", 0)).toBeNull();
  });

  it("reads the token only up to the caret, not to the end of the word", () => {
    expect(findSlashToken("/forge-drive", 4)).toEqual({ start: 0, end: 4, query: "for" });
  });

  it("has no token in plain text", () => {
    expect(findSlashToken("hello there", 11)).toBeNull();
    expect(findSlashToken("", 0)).toBeNull();
  });

  it("clamps a caret outside the value instead of misreading it", () => {
    expect(findSlashToken("/forge", 99)).toEqual({ start: 0, end: 6, query: "forge" });
    expect(findSlashToken("/forge", -3)).toBeNull();
  });
});

/** Find the token or fail the test — keeps the cases below free of `!`. */
function tokenAt(value: string, caret: number) {
  const token = findSlashToken(value, caret);
  if (!token) throw new Error(`no slash token in ${JSON.stringify(value)} at ${caret}`);
  return token;
}

describe("replaceSlashToken", () => {
  it("completes the token and leaves the caret past a trailing space", () => {
    expect(replaceSlashToken("/for", tokenAt("/for", 4), "forge-drive")).toEqual({
      value: "/forge-drive ",
      caret: 13,
    });
  });

  it("keeps the text around the token", () => {
    const value = "please /for it";
    expect(replaceSlashToken(value, tokenAt(value, 11), "forge-drive")).toEqual({
      value: "please /forge-drive it",
      caret: 19,
    });
  });

  it("does not double the space when one already follows", () => {
    const value = "/for rest";
    expect(replaceSlashToken(value, tokenAt(value, 4), "forge-drive")).toEqual({
      value: "/forge-drive rest",
      caret: 12,
    });
  });
});

describe("filterSkillsByQuery", () => {
  const skills = [{ name: "forge-code" }, { name: "forge-drive" }, { name: "dataviz" }];

  it("lists everything for an empty query", () => {
    expect(filterSkillsByQuery(skills, "")).toEqual(skills);
    expect(filterSkillsByQuery(skills, "  ")).toEqual(skills);
  });

  it("matches a substring case-insensitively and keeps the incoming order", () => {
    expect(filterSkillsByQuery(skills, "FOR").map((s) => s.name)).toEqual([
      "forge-code",
      "forge-drive",
    ]);
    expect(filterSkillsByQuery(skills, "viz").map((s) => s.name)).toEqual(["dataviz"]);
  });

  it("returns nothing when no name matches (a filtered-empty, not a first-run empty)", () => {
    expect(filterSkillsByQuery(skills, "nope")).toEqual([]);
  });
});
