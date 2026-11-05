import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { markSaidTitle } from "./mark-said-title";
import type { MarkSaidRecord } from "./types";

const t = productCopy("en");
const said = (over: Partial<MarkSaidRecord> = {}): MarkSaidRecord => ({
  at: "2026-11-05T00:00:00.000Z",
  by: { id: "u1", name: "Chuong", agency: "agent" },
  run: null,
  said: {},
  commitReading: null,
  ...over,
});

describe("the mark's hover says who marked it and what the repository read (ISS-1017)", () => {
  it("names who said it by name", () => {
    expect(markSaidTitle(t, said())).toBe("Marked by Chuong");
  });

  it("names an agent where the record holds no name", () => {
    expect(markSaidTitle(t, said({ by: { id: "u1", name: null, agency: "agent" } }))).toBe("Marked by an agent");
  });

  it("adds the repository's reading of a named commit", () => {
    const found = said({ commitReading: { commit: "a".repeat(40), outcome: "found", branch: "main" } });
    expect(markSaidTitle(t, found)).toBe("Marked by Chuong\nRepository: found on main");
    const unread = said({ commitReading: { commit: "a".repeat(40), outcome: "unread" } });
    expect(markSaidTitle(t, unread)).toBe("Marked by Chuong\nRepository: not read");
  });

  it("says nothing for a mark made before the record existed", () => {
    expect(markSaidTitle(t, null)).toBeUndefined();
  });
});
