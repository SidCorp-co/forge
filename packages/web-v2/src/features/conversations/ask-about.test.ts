import { describe, expect, it } from "vitest";
import { aboutDraft } from "./ask-about";

describe("Ask about this", () => {
  it("names the object first in the message the person sends", () => {
    expect(aboutDraft("issue", "ISS-24")).toBe("About issue ISS-24: ");
    expect(aboutDraft("run", " r-1 ")).toBe("About run r-1: ");
  });

  it.each([
    ["issue", ""],
    ["issue", "  "],
    ["secret", "ISS-1"],
  ] as const)("drafts nothing for %s %j", (kind, ref) => {
    expect(aboutDraft(kind as never, ref)).toBeUndefined();
  });
});
