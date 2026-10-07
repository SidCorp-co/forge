import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NO_MASTER_SLOTS } from "@forge/contracts/master-standing";
import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { signalNote } from "./signals-strip";

// Core's own sentences on the Development overview, held to core's source: a signal it cannot read
// (`development/overview-read.ts`, contracts `master-standing.ts:NO_MASTER_SLOTS`).

const core = (file: string) => readFileSync(resolve(__dirname, "../../../../../core/src", file), "utf8");
const constant = (src: string, name: string) => {
  const m = new RegExp(`const ${name} =\\s*\\n?\\s*'((?:[^'\\\\]|\\\\.)+)'`).exec(src);
  if (!m) throw new Error(`core no longer declares ${name}`);
  return m[1] as string;
};

describe("the Development overview reads core's own sentences", () => {
  const read = core("development/overview-read.ts");
  const notes = [constant(read, "CI_UNAVAILABLE"), constant(read, "POST_MERGE_UNAVAILABLE"), NO_MASTER_SLOTS];

  it("spells each signal note in en as core writes it, and reads it in vi", () => {
    for (const n of notes) {
      expect(signalNote(n, productCopy("en"))).toBe(n);
      expect(signalNote(n, productCopy("vi"))).not.toBe(n);
    }
    expect(signalNote("A note core added later.", productCopy("vi"))).toBe("A note core added later.");
  });
});
