"use client";

// The act that answers "promote N draft issues" (FB-93): one press among the requirement's acts, and
// one on each draft row. Both read the drafts from `draftIssuesToPromote`, the rule core's standing
// counts the waiting line with, so the ask and its act come and go together. Only a signer who can
// admit issues is offered it (`canPromote`, question 3b8292dc), the one person core's standing asks.
// Each draft moves through its own status move in core; one core refused is named here, in words for
// a person, while the rest moved.

import { draftIssuesToPromote, type RefusedDraftIssue } from "@forge/contracts/requirements";
import { Button, LEGEND, Tooltip } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import type { Refusal } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { usePromoteDrafts } from "../hooks";
import type { RequirementDetail, RequirementIssueLink } from "../types";

const REFUSAL_WORDS = {
  ISSUE_ARCHIVED: "requirements.promote.refusal.archived",
  PERMISSION_FORBIDDEN: "requirements.promote.refusal.forbidden",
  STALE_TRANSITION: "requirements.promote.refusal.moved",
  ILLEGAL_TRANSITION: "requirements.promote.refusal.moved",
  NO_OP: "requirements.promote.refusal.moved",
  REQUIREMENT_ISSUE_NOT_DRAFT: "requirements.promote.refusal.moved",
} as const;

const isWorded = (code: string): code is keyof typeof REFUSAL_WORDS => code in REFUSAL_WORDS;

/** Why one draft stayed a draft, from its code and key; core's own detail is an API instruction. */
const refusedWords = (key: string, code: string, t: Copy) =>
  isWorded(code) ? t(REFUSAL_WORDS[code], { key }) : t("requirements.promote.refusal.other", { key, code });

/** A refusal of the whole act: one naming a draft by `/issues/<key>` is worded as that draft; the rest read as core wrote them. */
const actRefusalWords = (t: Copy) => (r: Refusal) => {
  if (r.code === "REQUIREMENT_NO_DRAFT_ISSUES") return t("requirements.promote.refusal.none");
  const key = r.path.startsWith("/issues/") ? r.path.slice("/issues/".length) : "";
  return /^[A-Za-z][\w-]*-\d+$/.test(key) ? refusedWords(key, r.code, t) : null;
};

/** "Not promoted: ISS-11 is archived, …": each draft core refused while the others moved. */
function RefusedLine({ refused }: { refused: RefusedDraftIssue[] | undefined }) {
  const t = useCopy();
  if (!refused?.length) return null;
  return (
    <p role="alert" className="min-w-0 px-3 py-1.5 text-12" style={{ color: LEGEND.err.fg, background: LEGEND.err.bg }} data-testid="promote-refused">
      {t("requirements.promote.refused")}{" "}
      {refused.map((r, n) => (
        <span key={`${r.issueId}-${r.code}`} title={r.code}>
          {n > 0 ? " " : null}
          {refusedWords(r.displayId, r.code, t)}
        </span>
      ))}
    </p>
  );
}

/** "Promote N draft issues": every draft linked to the requirement, offered to a signer who can admit them. */
export function PromoteDrafts({ projectId, d }: { projectId: string; d: RequirementDetail }) {
  const t = useCopy();
  const promote = usePromoteDrafts(projectId, d.key);
  const drafts = draftIssuesToPromote(d.status, d.issues);
  if (!d.canPromote || drafts.length === 0) return null;
  return (
    <>
      <Tooltip label={t("requirements.promote.tip", { keys: drafts.map((i) => i.displayId).join(", ") })} multiline>
        <Button type="button" size="sm" variant="primary" loading={promote.isPending} onClick={() => promote.mutate(undefined)}>
          {drafts.length === 1 ? t("requirements.promote.one") : t("requirements.promote.many", { n: drafts.length })}
        </Button>
      </Tooltip>
      <RefusedLine refused={promote.data?.refused} />
      <RefusalLine error={promote.error} words={actRefusalWords(t)} />
    </>
  );
}

/** A draft row's own promote: that one issue, by name. */
export function PromoteDraftRow({ projectId, d, issue }: { projectId: string; d: RequirementDetail; issue: RequirementIssueLink }) {
  const t = useCopy();
  const promote = usePromoteDrafts(projectId, d.key);
  const promotable = d.canPromote && draftIssuesToPromote(d.status, [issue]).length > 0;
  if (!promotable) return null;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" aria-label={t("requirements.promote.rowLabel", { key: issue.displayId })} loading={promote.isPending} onClick={() => promote.mutate([issue.issueId])}>
        {t("requirements.promote.row")}
      </Button>
      <RefusedLine refused={promote.data?.refused} />
      <RefusalLine error={promote.error} words={actRefusalWords(t)} />
    </>
  );
}
