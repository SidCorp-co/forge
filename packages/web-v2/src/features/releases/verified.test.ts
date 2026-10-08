import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { verifiedSentence } from "./verified";

const en = productCopy("en");
const vi = productCopy("vi");

describe("what a release verified, in words", () => {
  it("names the provider that served a provider-checked deploy, in both languages", () => {
    const v = { level: "criteria", proven: 3, total: 3, check: "provider", provider: "Autoflow" } as const;
    expect(verifiedSentence(v, en)).toBe("Verified: 3 criteria proven, and the deploy checked by what Autoflow serves");
    const named = vi("releases.verified.byNamedProvider", { provider: "Autoflow" });
    expect(named).toContain("Autoflow");
    expect(verifiedSentence(v, vi).endsWith(named)).toBe(true);
    expect(verifiedSentence(v, vi)).not.toContain(vi("releases.verified.byProvider"));
  });

  it("says production's provider only where the facts name none, never a blank name", () => {
    const v = { level: "criteria", proven: 3, total: 3, check: "provider", provider: null } as const;
    expect(verifiedSentence(v, en)).toBe("Verified: 3 criteria proven, and the deploy checked by what production's provider serves");
    expect(verifiedSentence(v, vi).endsWith(vi("releases.verified.byProvider"))).toBe(true);
    expect(verifiedSentence({ ...v, provider: "" }, en)).toBe(verifiedSentence(v, en));
  });

  it("says a probed deploy by the probes, and a deploy-only level alone", () => {
    expect(verifiedSentence({ level: "some_criteria", proven: 1, total: 2, check: "probed", provider: null }, en)).toBe(
      "Partly verified: 1 of 2 criteria proven, and the deploy checked by the production probes",
    );
    expect(verifiedSentence({ level: "deploy_only", proven: 0, total: 0, check: "probed", provider: null }, en)).toBe(
      "Deploy check only: no criteria recorded",
    );
  });
});
