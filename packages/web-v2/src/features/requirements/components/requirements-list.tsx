
// The list (REQ-29 BC-4, BC-5): one line per requirement, in groups by attention or by area, drawn by
// the shared GroupedList every entity list uses. The attention groups are the one vocabulary a
// requirement and a feedback row share (FB-583): Needs you, Running, Queued, Overdue, Waiting on
// others, Deferred, Done, Dropped, each folded as the contract says, so Dropped is never inside Done.
// Its columns are a requirement's: Passing where an issue has State, Waits on, and the age of its
// current state. A row leads with the requirement's name; its key is the name's tooltip (REQ-11
// BC-19). The group says where it stands, so a row says it nowhere twice: no stage word, and no
// steward sentence restating the cause, which the requirement's own page shows (REQ-48 BC-7).

import { REQUIREMENT_ATTENTION_GROUPS, REQUIREMENT_ATTENTION_LABELS, type RequirementSummary } from "@forge/contracts/requirements";
import { GroupedList, type ListGroup, useGroupFold, WaitingOn } from "@/design";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";
import { ageShort, nameOf, Passing, RowState } from "./requirement-line";

type ListGrouping = "attention" | "area";

export function listGroupsOf(rows: RequirementSummary[], by: ListGrouping, areas: { id: string; name: string }[], label: (g: string) => string, noArea: string): ListGroup<RequirementSummary>[] {
  const newest = (a: RequirementSummary, b: RequirementSummary) => b.standing.touchedAt.localeCompare(a.standing.touchedAt);
  const groups: ListGroup<RequirementSummary>[] =
    by === "attention"
      ? REQUIREMENT_ATTENTION_GROUPS.map((g) => ({ id: g, label: label(g), rows: rows.filter((r) => r.standing.attentionGroup === g), collapsed: REQUIREMENT_ATTENTION_LABELS[g].collapsed }))
      : [
          ...areas.map((a) => ({ id: a.id, label: a.name, rows: rows.filter((r) => r.area?.id === a.id) })),
          { id: "none", label: noArea, rows: rows.filter((r) => !r.area) },
        ];
  return groups.filter((g) => g.rows.length > 0).map((g) => ({ ...g, rows: [...g.rows].sort(newest) }));
}

/** Ended, delivered or not: nothing is owed, so the row is quiet and names no wait. */
const ended = (r: RequirementSummary) => r.standing.attentionGroup === "done" || r.standing.attentionGroup === "dropped";

export function RequirementsList({ groups, slug, now, selected, onPeek }: { groups: ListGroup<RequirementSummary>[]; slug: string; now: number; selected: string | null; onPeek: (key: string) => void }) {
  const t = useCopy();
  const time = useTimeFormat();
  const fold = useGroupFold("requirements-list");
  return (
    <div data-testid="requirements-list" className="pb-16">
      <GroupedList
        ariaLabel={t("requirements.title")}
        groups={groups}
        fold={fold}
        selected={selected}
        onPeek={onPeek}
        empty={t("requirements.noMatch")}
        keyColumn={false}
        columns={{ title: t("requirements.col.name"), state: t("requirements.col.passing"), waitingOn: t("requirements.col.waits"), meta: t("requirements.col.age") }}
        row={(r) => ({
          key: r.key,
          href: requirementHref(slug, r.key),
          title: (
            <span className="flex min-w-0 items-center gap-2.5" title={r.shortName ? `${r.key} · ${r.title}` : undefined}>
              <span className="truncate">{nameOf(r)}</span>
              <RowState r={r} />
            </span>
          ),
          facts: [],
          state: <Passing r={r} wide={false} />,
          // the shared one-line cell (ISS-1072): whose turn and a short act, the whole sentence its tooltip
          waitingOn: ended(r) ? null : <WaitingOn w={r.standing.waitingOn} />,
          owner: null,
          age: { text: ageShort(r.standing.stateSince, now), title: time.dateTime(r.standing.stateSince) },
          dim: ended(r),
        })}
      />
    </div>
  );
}

/** The label for an attention group. */
export function useAttentionLabel() {
  const label = useLabel();
  return (g: string) => label("requirementAttention", g);
}
