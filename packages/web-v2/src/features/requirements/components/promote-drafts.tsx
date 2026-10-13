
// The act that answers "promote N draft issues" (FB-93): one press among the requirement's acts, and
// one on each draft row. Both read the drafts from `draftIssuesToPromote`, the rule core's standing
// counts the waiting line with, so the ask and its act come and go together. Only a signer who can
// admit issues is offered it (`canPromote`, question 3b8292dc), the one person core's standing asks.
// Each draft moves through its own status move in core; one core refused is named here once, with
// each of core's own refusals for it once beneath it, whether the rest moved or none did (REQ-34
// BC-2, BC-18). Core's words are what a person reads: a refusal's code and the field its path points
// at stay machine-readable, on the line's attributes.

import { draftIssuesToPromote } from "@forge/contracts/requirements";
import { Button, LEGEND, Tooltip } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { namedRefusals, type Refusal } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import { usePromoteDrafts } from "../hooks";
import type { RequirementDetail, RequirementIssueLink } from "../types";

/** The codes whose core detail is an API instruction rather than words for a person: this page words them. */
const REFUSAL_WORDS = {
  ISSUE_ARCHIVED: "requirements.promote.refusal.archived",
  PERMISSION_FORBIDDEN: "requirements.promote.refusal.forbidden",
  STALE_TRANSITION: "requirements.promote.refusal.moved",
  ILLEGAL_TRANSITION: "requirements.promote.refusal.moved",
  NO_OP: "requirements.promote.refusal.moved",
  REQUIREMENT_ISSUE_NOT_DRAFT: "requirements.promote.refusal.moved",
} as const;

const isWorded = (code: string): code is keyof typeof REFUSAL_WORDS => code in REFUSAL_WORDS;

/** One refusal of one draft: its key, core's code and words, and where in that draft's move it points. */
interface DraftRefusal {
  key: string;
  code: string;
  path: string;
  detail: string;
}

/** A whole-act refusal names its draft first, then the place in that draft's move: `/issues/ISS-2/answers/requirement`. */
const DRAFT_PATH = /^\/issues\/([A-Za-z][\w-]*-\d+)(\/.*)?$/;

/**
 * The act's own refusals, when every one names a draft (none of the drafts moved); null when any is
 * about the act itself (nothing at draft, not a signer), which reads as a refusal of the act.
 */
function draftRefusalsOf(refusals: readonly Refusal[]): DraftRefusal[] | null {
  const out: DraftRefusal[] = [];
  for (const r of refusals) {
    const m = DRAFT_PATH.exec(r.path);
    if (!m?.[1]) return null;
    const key = m[1];
    const prefix = `${key}: `;
    out.push({ key, code: r.code, path: m[2] ?? "", detail: r.detail.startsWith(prefix) ? r.detail.slice(prefix.length) : r.detail });
  }
  return out.length > 0 ? out : null;
}

/** Each draft once, in the order core named them, with its refusals beneath it. */
function byDraft(refusals: readonly DraftRefusal[]): { key: string; refusals: DraftRefusal[] }[] {
  const drafts = new Map<string, DraftRefusal[]>();
  for (const r of refusals) drafts.set(r.key, [...(drafts.get(r.key) ?? []), r]);
  return [...drafts].map(([key, rs]) => ({ key, refusals: rs }));
}

/**
 * "Not promoted:" and each draft core refused, once: this page's words for a code core words for an
 * API caller (once per draft), and core's own words for every other refusal, each once.
 */
function RefusedDrafts({ refusals }: { refusals: readonly DraftRefusal[] }) {
  const t = useCopy();
  if (refusals.length === 0) return null;
  return (
    <div role="alert" className="min-w-0 px-3 py-1.5 text-12" style={{ color: LEGEND.err.fg, background: LEGEND.err.bg }} data-testid="promote-refused">
      <p>{t("requirements.promote.refused")}</p>
      <ul className="flex flex-col gap-1">
        {byDraft(refusals).map(({ key, refusals: rs }) => {
          const worded = [...new Set(rs.map((r) => r.code).filter(isWorded))];
          const said = rs.filter((r) => !isWorded(r.code));
          return (
            <li key={key} data-issue={key}>
              {worded.map((code) => (
                <span key={code} title={code} data-code={code}>
                  {t(REFUSAL_WORDS[code], { key })}{" "}
                </span>
              ))}
              {said.length > 0 ? (
                <>
                  {t("requirements.promote.refusal.stays", { key })}
                  {said.map((r) => (
                    <span key={`${r.code}${r.path}`} title={r.code} data-code={r.code} data-path={r.path} className="block">
                      {r.detail}
                    </span>
                  ))}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What the act answered or why it moved none: the drafts core refused, or a refusal of the act itself. */
function PromoteRefusals({ promote }: { promote: ReturnType<typeof usePromoteDrafts> }) {
  const t = useCopy();
  const moved = promote.data?.refused.map((r) => ({ key: r.displayId, code: r.code, path: r.path, detail: r.detail }));
  if (moved?.length) return <RefusedDrafts refusals={moved} />;
  const whole = draftRefusalsOf(namedRefusals(promote.error));
  if (whole) return <RefusedDrafts refusals={whole} />;
  return (
    <RefusalLine
      error={promote.error}
      words={(r) => (r.code === "REQUIREMENT_NO_DRAFT_ISSUES" ? t("requirements.promote.refusal.none") : null)}
    />
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
      <PromoteRefusals promote={promote} />
    </>
  );
}

/** A draft row's own promote: that one issue, by name. */
export function PromotableDraft({ projectId, d, issue }: { projectId: string; d: RequirementDetail; issue: RequirementIssueLink }) {
  const t = useCopy();
  const promote = usePromoteDrafts(projectId, d.key);
  const promotable = d.canPromote && draftIssuesToPromote(d.status, [issue]).length > 0;
  if (!promotable) return null;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" aria-label={t("requirements.promote.rowLabel", { key: issue.displayId })} loading={promote.isPending} onClick={() => promote.mutate([issue.issueId])}>
        {t("requirements.promote.row")}
      </Button>
      <PromoteRefusals promote={promote} />
    </>
  );
}
