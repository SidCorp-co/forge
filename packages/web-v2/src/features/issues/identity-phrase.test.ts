import { identityPhraseOf } from "@forge/contracts/verdict-identity";
import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { identityPhrase } from "./identity-phrase";

type Reading = Parameters<typeof identityPhraseOf>[0];

const base: Reading = {
  verdict: "pass",
  identityKind: "commit",
  commitSha: "abcdef0123456789",
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
} as unknown as Reading;

const READINGS: Record<string, Reading> = {
  commit: base,
  commit_unresolved: { ...base, identityKind: "commit_unresolved", commitSha: "abc123" },
  runtime: { ...base, identityKind: "runtime", runtimeRef: "run-0123456789abcdef" },
  design: { ...base, identityKind: "design", designFlow: "checkout", designRevision: 4 },
  contract: { ...base, identityKind: "contract", contractRef: "issue-vocabulary", contractVersion: "7" },
  storefront: { ...base, identityKind: "storefront_draft", storefrontWorkflowId: "wf1", storefrontDraftVersion: "v1234567890123", storefrontEnvironment: "preview", corroboration: "corroborated" },
  storefrontUncorroborated: { ...base, identityKind: "storefront_draft", storefrontWorkflowId: "wf1", storefrontDraftVersion: "v1", storefrontEnvironment: "preview", corroboration: "uncorroborated", corroborationNote: "no match" },
  none: { ...base, identityKind: "other" as never },
};

describe("identityPhrase", () => {
  it.each(Object.entries(READINGS))("reads in English as the contract's own sentence: %s", (_k, v) => {
    expect(identityPhrase(v)).toBe(identityPhraseOf(v));
  });

  it("reads in Vietnamese with no English word of the sentence left", () => {
    const vi = productCopy("vi");
    expect(identityPhrase(READINGS.design as Reading, vi)).toBe("thiết kế checkout bản 4"); // i18n-allow: asserts the vi copy itself
    expect(identityPhrase(READINGS.storefrontUncorroborated as Reading, vi)).toBe("bản nháp storefront wf1@v1 trên preview (chưa đối chiếu: no match)"); // i18n-allow: asserts the vi copy itself
    expect(identityPhrase(READINGS.none as Reading, vi)).toBe("không có định danh"); // i18n-allow: asserts the vi copy itself
  });

  it("prints a field the verdict does not carry as a dash, never the word undefined", () => {
    expect(identityPhrase({ ...base, identityKind: "runtime", runtimeRef: null })).toBe("runtime —");
  });
});
