"use client";

// The act that answers "promote N draft issues" (FB-93): one press among the requirement's acts, and
// one on each draft row. Both read the drafts from `draftIssuesToPromote`, the rule core's standing
// counts the waiting line with, so the ask and its act come and go together. Each draft moves through
// its own status move in core; one core refused is named here while the rest moved.

import { draftIssuesToPromote, type RefusedDraftIssue } from "@forge/contracts/requirements";
import { Button, LEGEND, Tooltip } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { usePromoteDrafts } from "../hooks";
import type { RequirementDetail, RequirementIssueLink } from "../types";

/** "Not promoted: ISS-11 ISSUE_ARCHIVED …": each draft core refused while the others moved. */
function RefusedLine({ refused }: { refused: RefusedDraftIssue[] | undefined }) {
  const t = useCopy();
  if (!refused?.length) return null;
  return (
    <p role="alert" className="min-w-0 px-3 py-1.5 text-12" style={{ color: LEGEND.err.fg, background: LEGEND.err.bg }} data-testid="promote-refused">
      {t("requirements.promote.refused")}{" "}
      {refused.map((r, n) => (
        <span key={`${r.issueId}-${r.code}`}>
          {n > 0 ? "; " : null}
          <span className="font-mono font-semibold">
            {r.displayId} {r.code}
          </span>{" "}
          {r.detail}
        </span>
      ))}
    </p>
  );
}

/** "Promote N draft issues": every draft linked to the requirement, offered to whoever can sign it. */
export function PromoteDrafts({ projectId, d }: { projectId: string; d: RequirementDetail }) {
  const t = useCopy();
  const promote = usePromoteDrafts(projectId, d.key);
  const drafts = draftIssuesToPromote(d.status, d.issues);
  if (!d.canSignOff || drafts.length === 0) return null;
  return (
    <>
      <Tooltip label={t("requirements.promote.tip", { keys: drafts.map((i) => i.displayId).join(", ") })} multiline>
        <Button type="button" size="sm" variant="primary" loading={promote.isPending} onClick={() => promote.mutate(undefined)}>
          {drafts.length === 1 ? t("requirements.promote.one") : t("requirements.promote.many", { n: drafts.length })}
        </Button>
      </Tooltip>
      <RefusedLine refused={promote.data?.refused} />
      <RefusalLine error={promote.error} />
    </>
  );
}

/** A draft row's own promote: that one issue, by name. */
export function PromoteDraftRow({ projectId, d, issue }: { projectId: string; d: RequirementDetail; issue: RequirementIssueLink }) {
  const t = useCopy();
  const promote = usePromoteDrafts(projectId, d.key);
  const promotable = d.canSignOff && draftIssuesToPromote(d.status, [issue]).length > 0;
  if (!promotable) return null;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" aria-label={t("requirements.promote.rowLabel", { key: issue.displayId })} loading={promote.isPending} onClick={() => promote.mutate([issue.issueId])}>
        {t("requirements.promote.row")}
      </Button>
      <RefusedLine refused={promote.data?.refused} />
      <RefusalLine error={promote.error} />
    </>
  );
}
