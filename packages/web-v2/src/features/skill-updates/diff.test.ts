import { describe, expect, it } from "vitest";
import { diffLines, diffStat, withContext } from "./diff";

describe("diffLines", () => {
  it("reports no change for identical bodies", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(diffStat(d)).toEqual({ added: 0, removed: 0 });
  });

  // cm:why the reviewer's whole decision rests on seeing removals — rendering a replaced line as one add would let a rewrite read as an edit
  it("shows a replaced line as one removal and one addition", () => {
    const d = diffLines("keep\nold\nkeep2", "keep\nnew\nkeep2");
    expect(diffStat(d)).toEqual({ added: 1, removed: 1 });
    expect(d.find((l) => l.kind === "removed")?.text).toBe("old");
    expect(d.find((l) => l.kind === "added")?.text).toBe("new");
  });

  it("keeps surrounding lines unchanged when text is inserted", () => {
    const d = diffLines("a\nc", "a\nb\nc");
    expect(diffStat(d)).toEqual({ added: 1, removed: 0 });
    expect(d.filter((l) => l.kind === "same").map((l) => l.text)).toEqual(["a", "c"]);
  });

  it("counts every line as removed when the candidate is empty", () => {
    expect(diffStat(diffLines("a\nb", ""))).toEqual({ added: 1, removed: 2 });
  });
});

describe("withContext", () => {
  it("elides long unchanged stretches but keeps lines around each change", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 15", "line 15 edited");
    const shown = withContext(diffLines(before, after), 2);

    expect(shown.some((l) => l === null)).toBe(true);
    const texts = shown.filter((l) => l !== null).map((l) => l.text);
    expect(texts).toContain("line 13");
    expect(texts).toContain("line 15 edited");
    expect(texts).not.toContain("line 0");
  });

  it("elides nothing when every line changed", () => {
    const shown = withContext(diffLines("a\nb", "x\ny"), 2);
    expect(shown.every((l) => l !== null)).toBe(true);
  });
});
