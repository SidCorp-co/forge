import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { recordDetail } from "./derive";

// A pulse record's detail as core words it (`me/pulse-actions.ts`), held to core's source.

const core = (file: string) => readFileSync(resolve(__dirname, "../../../../core/src", file), "utf8");

describe("the workspace Overview reads core's record details", () => {
  it("reads a pulse record's detail in vi, keeping a title, a sha and a branch", () => {
    const actions = core("me/pulse-actions.ts");
    expect(actions).toContain("${p.backlog} ${p.backlog === 1 ? 'issue' : 'issues'} waiting");
    expect(actions).toContain("${i.title} · ${first.sha.slice(0, 8)} not on ${i.deploysFrom}");
    const en = productCopy("en");
    const vi = productCopy("vi");
    expect(recordDetail("1 issue waiting", en)).toBe("1 issue waiting");
    expect(recordDetail("3 issues waiting", en)).toBe("3 issues waiting");
    expect(recordDetail("3 issues waiting", vi)).not.toMatch(/waiting/);
    expect(recordDetail("Muc · abcdef12 not on prod", en)).toBe("Muc · abcdef12 not on prod");
    expect(recordDetail("Muc · abcdef12 not on prod", vi)).toMatch(/^Muc · abcdef12 .*prod$/);
    expect(recordDetail("Muc · abcdef12 not on prod", vi)).not.toMatch(/not on/);
    expect(recordDetail("hop", vi)).toBe("hop");
  });
});
