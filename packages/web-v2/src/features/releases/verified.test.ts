import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { verifiedSentence } from "./verified";

const en = productCopy("en");
const vi = productCopy("vi");

describe("what a release verified, in words", () => {
  it("says a deploy the provider proved by what the provider serves, never a blank name", () => {
    const v = { level: "criteria", proven: 3, total: 3, check: "provider" } as const;
    expect(verifiedSentence(v, en)).toBe("Verified: 3 criteria proven, and the deploy checked by what production's provider serves");
    expect(verifiedSentence(v, vi)).not.toMatch(/\s{2}|\{provider\}/);
  });

  it("says a probed deploy by the probes, and a deploy-only level alone", () => {
    expect(verifiedSentence({ level: "some_criteria", proven: 1, total: 2, check: "probed" }, en)).toBe(
      "Partly verified: 1 of 2 criteria proven, and the deploy checked by the production probes",
    );
    expect(verifiedSentence({ level: "deploy_only", proven: 0, total: 0, check: "probed" }, en)).toBe("Deploy check only: no criteria recorded");
  });
});
