import { describe, expect, it } from "vitest";
import { BADGE, type CriterionVerdict, criterionBadge } from "./criteria";

const v = (over: Partial<CriterionVerdict>): CriterionVerdict => ({
  verdict: "pass",
  reason: null,
  identityKind: "commit",
  commitSha: "3641ba21fec5096e2d1a91a40f2d9e50e9239068",
  runtimeRef: null,
  designFlow: null,
  designWorkflowId: null,
  designRevision: null,
  contractRef: null,
  contractVersion: null,
  storefrontWorkflowId: null,
  storefrontDraftVersion: null,
  storefrontEnvironment: null,
  corroboration: null,
  corroborationNote: null,
  evidence: [],
  authorAgency: "agent",
  backfilled: false,
  createdAt: "2026-10-03T00:00:00.000Z",
  ...over,
});

describe("criterionBadge (ISS-55)", () => {
  it("reads pass and short as Pass, fail as Fail, skipped as Skipped", () => {
    expect(criterionBadge(v({}))).toBe("pass");
    expect(criterionBadge(v({ verdict: "short" }))).toBe("pass");
    expect(criterionBadge(v({ verdict: "fail" }))).toBe("fail");
    expect(criterionBadge(v({ verdict: "skipped", identityKind: null }))).toBe("skipped");
  });

  it("reads a backfilled abbreviated commit as Unresolved even where it passed", () => {
    expect(criterionBadge(v({ identityKind: "commit_unresolved", commitSha: "1810f84" }))).toBe("unresolved");
  });

  it("reads no verdict as Not judged, and labels every state in sentence case", () => {
    expect(criterionBadge(null)).toBe("unjudged");
    expect(Object.values(BADGE).map((b) => b.label)).toEqual(["Pass", "Fail", "Skipped", "Unresolved", "Not judged"]);
  });
});
