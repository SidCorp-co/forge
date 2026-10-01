import { describe, expect, it } from "vitest";
import { splitCorrections, withoutCorrections } from "./corrections";

const LINE = "Correction: the submit of FP-ACK-7 was refused (CHANNEL_NOT_A_PARTY); nothing was written.";

describe("a correction line in a reply", () => {
  it("is lifted out of the prose with what was refused and its code", () => {
    const { prose, corrections } = splitCorrections(`I sent FP-ACK-7.\n\n${LINE}`);
    expect(prose).toBe("I sent FP-ACK-7.");
    expect(corrections).toEqual([
      { line: LINE, what: "the submit of FP-ACK-7", code: "CHANNEL_NOT_A_PARTY" },
    ]);
  });

  it("is lifted out of the entry's text blocks as well as its content", () => {
    const { entry, corrections } = withoutCorrections({
      type: "assistant",
      content: `Done.\n\n${LINE}`,
      blocks: [{ type: "text", text: `Done.\n\n${LINE}` }],
    });
    expect(corrections).toHaveLength(1);
    expect(entry.content).toBe("Done.");
    expect(entry.blocks).toEqual([{ type: "text", text: "Done." }]);
  });

  it("leaves prose that only mentions a correction alone", () => {
    const text = "Correction: the release name is Bluebird.";
    expect(splitCorrections(text)).toEqual({ prose: text, corrections: [] });
  });
});
