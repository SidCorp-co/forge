import type { DesignApprovalBlock, DesignBaseFault, DesignLeftStale } from "@forge/contracts/workflows";
import { statusReading } from "@/design";
import type { Refusal } from "@/lib/api/refusals";
import { type Copy, copyLocale } from "@/lib/i18n/product-copy";

// A design decision refusal in the viewer's language, worded from the facts core carries beside its
// detail (the refusal's code and params), never from the English detail itself; a refusal without
// those facts reads as core wrote it.

const list = (items: string[], language: string) => new Intl.ListFormat(copyLocale(language), { type: "conjunction" }).format(items);

const BASE_STATES = {
  stale: "workflows.refusal.base.stale",
  unapproved: "workflows.refusal.base.unapproved",
  missing: "workflows.refusal.base.missing",
} as const;

const baseWords = (b: DesignBaseFault, t: Copy) => t(BASE_STATES[b.state], { flow: b.workflow, r: b.revision, approved: b.approvedRevision ?? "" });

/** Why Approve is off while the proposed revision rests on a base not approved at the revision it names. */
export function blockedWords(block: Pick<DesignApprovalBlock, "revision" | "bases">, t: Copy, language: string): string {
  return t("workflows.refusal.baseUnapproved", { r: block.revision, bases: list(block.bases.map((b) => baseWords(b, t)), language) });
}

/** The designs approving `revision` strands on a stale base, named before the click; null when there are none. */
export function leavesStaleWords(revision: number, stale: readonly DesignLeftStale[], t: Copy, language: string): string | null {
  if (stale.length === 0) return null;
  return t("workflows.leavesStale", { r: revision, designs: list(stale.map((s) => `${s.flow} r${s.revision}`), language) });
}

const isBases = (v: unknown): v is DesignBaseFault[] => Array.isArray(v) && v.every((b) => b && typeof b === "object" && typeof (b as DesignBaseFault).workflow === "string" && (b as DesignBaseFault).state in BASE_STATES);
const isNumber = (v: unknown): v is number => typeof v === "number";

/** A decision refusal worded from its code and facts, or null where it carries none this screen words. */
export function decisionRefusalWords(r: Refusal, t: Copy, language: string): string | null {
  const facts = r as Refusal & Record<string, unknown>;
  switch (r.code) {
    case "WORKFLOW_DESIGN_BASE_UNAPPROVED":
      return isNumber(facts.revision) && isBases(facts.bases) ? blockedWords({ revision: facts.revision, bases: facts.bases }, t, language) : null;
    case "WORKFLOW_DESIGN_NOT_PROPOSED":
      return "status" in facts ? t("workflows.refusal.notProposed", { status: typeof facts.status === "string" ? statusReading("design", facts.status, language).label : t("workflows.refusal.noLifecycle") }) : null;
    case "WORKFLOW_DESIGN_REVISION_STALE":
      return isNumber(facts.revision) && isNumber(facts.proposedRevision) ? t("workflows.refusal.revisionStale", { r: facts.revision, current: facts.proposedRevision }) : null;
    case "WORKFLOW_DESIGN_REASON_MISSING":
      return t("workflows.refusal.reasonMissing");
    case "PERMISSION_FORBIDDEN":
      return typeof facts.permission === "string" ? t("workflows.refusal.forbidden", { permission: facts.permission }) : null;
    default:
      return null;
  }
}
