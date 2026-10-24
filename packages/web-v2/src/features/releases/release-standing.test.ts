import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { releaseStandingOf } from "./release-standing";

// REQ-71 BC-6: where the owner deploys, a release ends at its last merge and asks for no production;
// otherwise it names where it runs, and one with nowhere to run says so.

const t = productCopy("en");
const date = (iso: string) => iso.slice(0, 10);
const base = {
  releasedAt: null,
  approval: null,
  approvalRequired: true,
  verified: { level: "none", proven: 0, total: 0, check: null, provider: null },
} as const;

type Facts = Parameters<typeof releaseStandingOf>[0];

const standing = (r: Partial<Facts>) => {
  const facts: Facts = { ...base, state: "awaiting_approval", production: null, ownerDeploys: false, ...r };
  return releaseStandingOf(facts, t, date);
};

describe("a release whose owner deploys", () => {
  it("ends at merge and asks for the approval, never for a production environment", () => {
    const s = standing({ ownerDeploys: true });
    expect(s.goesTo).toBe("Ends at merge, the owner deploys");
    expect(s.next).toBe("Approve the release");
  });

  it("says the agent merges it once accepted, and reads merged once out", () => {
    const merging = standing({ ownerDeploys: true, state: "in_progress" });
    expect(merging.status).toBe("Accepted, merging");
    expect(merging.next).toBe("Wait while the agent merges it");
    const out = standing({ ownerDeploys: true, state: "shipped", releasedAt: "2026-10-25T09:00:00Z" });
    expect(out.status).toBe("Merged 2026-10-25");
    expect(out.next).toBeNull();
  });
});

describe("any other release", () => {
  it("names where it runs", () => {
    const s = standing({ production: { name: "production", url: "https://app.example.com" } });
    expect(s.goesTo).toBe("production");
    expect(s.next).toBe("Approve the release");
  });

  it("asks for a production environment where it has none", () => {
    const s = standing({});
    expect(s.goesTo).toBe("No production");
    expect(s.next).toBe("Add a production environment, then approve");
  });
});
