import type { identityPhraseOf } from "@forge/contracts/verdict-identity";
import { type Copy, type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";

/**
 * What a verdict was measured against, in the reader's language: the same sentence as the
 * contracts' `identityPhraseOf`, with its words read from the copy. The identifiers it carries
 * (a sha, a ref, a draft id) are printed as they are, and one the verdict does not carry as a dash.
 */
type VerdictReading = Parameters<typeof identityPhraseOf>[0];

export function identityPhrase(v: VerdictReading, t: Copy = productCopy()): string {
  switch (v.identityKind) {
    case "commit":
      return t("agents.identity.commit", { sha: v.commitSha?.slice(0, 12) ?? "—" });
    case "commit_unresolved":
      return t("agents.identity.commitUnresolved", { sha: v.commitSha ?? "—" });
    case "runtime":
      return t("agents.identity.runtime", { ref: v.runtimeRef?.slice(0, 12) ?? "—" });
    case "design":
      return t("agents.identity.design", { flow: v.designFlow ?? v.designWorkflowId ?? "—", rev: v.designRevision ?? "—" });
    case "contract":
      return t("agents.identity.contract", { ref: v.contractRef ?? "—", version: v.contractVersion ?? "—" });
    case "storefront_draft": {
      const status = v.corroboration ?? "uncorroborated";
      const note =
        v.corroboration === "corroborated"
          ? ""
          : t("agents.identity.corroboration", {
              status: t(`agents.identity.corroboration.${status}` as ProductCopyKey),
              note: v.corroborationNote ?? "—",
            });
      return t("agents.identity.storefront", {
        id: v.storefrontWorkflowId ?? "—",
        version: v.storefrontDraftVersion?.slice(0, 12) ?? "—",
        env: v.storefrontEnvironment ?? "—",
        note,
      });
    }
    default:
      return t("agents.identity.none");
  }
}
