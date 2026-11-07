import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { turnDoing } from "./turn-doing";

const t = productCopy("en");
const running = (name: string, input: Record<string, unknown>) =>
  ({ type: "tool", tool: { id: "c", name, input } }) as const;

describe("the stage line says what a live turn is doing", () => {
  it("says it is reading the project before the first call, and what each call is", () => {
    expect(turnDoing([], t)).toBe("Reading the project");
    expect(turnDoing([running("forge", { argv: ["issue", "--search", "export"] })], t)).toBe(
      "Reading the tracker: forge issue --search export",
    );
    expect(turnDoing([running("forge", { argv: ["new", "-", "--title", "x"] })], t)).toContain("Writing to the tracker");
    expect(turnDoing([running("forge_memory", { action: "search" })], t)).toBe("Searching project memory");
  });

  it("says nothing more once the call returned or the turn is writing", () => {
    expect(turnDoing([{ type: "tool", tool: { id: "c", name: "forge", result: "ok" } }], t)).toBeNull();
    expect(turnDoing([{ type: "text", text: "Answering" }], t)).toBeNull();
  });
});
