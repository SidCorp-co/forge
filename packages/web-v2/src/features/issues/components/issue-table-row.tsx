
import {
  Icon,
  type IconName,
  Menu,
  type MenuItem,
  type SelectOption,
} from "@/design";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import type { PatchIssueInput } from "../api";
import {
  COMPLEXITY_LABELS,
  PRIORITY_LABELS,
  liveDependencies,
  otherEnd,
} from "../derive";
import type {
  IssueDependencies,
  IssueDependencyEdge,
  IssueStatus,
} from "../types";

export interface RowActions {
  patch: (args: { id: string; body: PatchIssueInput }) => void;
  /** A move of the row's issue from the status the row shows it at. */
  transition: (args: { id: string; from: IssueStatus; toStatus: IssueStatus }) => void;
  isPending: boolean;
  /** False for project viewers (read-only): the row menu drops every mutation
   *  item and keeps only navigation. Optional — omitted means writable. */
  canWrite?: boolean;
}

/** Per-row bulk-selection state (ISS-463). When omitted the row renders no
 *  selection checkbox (viewers / non-bulk contexts). */
export interface RowSelection {
  selected: boolean;
  onToggle: (next: boolean) => void;
}

/** The New issue form's options, in English: that form's chrome is translated with its own change. */
const PRIORITY_OPTIONS: SelectOption[] = [
  { value: "critical", label: PRIORITY_LABELS.critical },
  { value: "high", label: PRIORITY_LABELS.high },
  { value: "medium", label: PRIORITY_LABELS.medium },
  { value: "low", label: PRIORITY_LABELS.low },
  { value: "none", label: PRIORITY_LABELS.none },
];

const COMPLEXITY_OPTIONS: SelectOption[] = [
  { value: "", label: "—" },
  { value: "xs", label: COMPLEXITY_LABELS.xs },
  { value: "s", label: COMPLEXITY_LABELS.s },
  { value: "m", label: COMPLEXITY_LABELS.m },
  { value: "l", label: COMPLEXITY_LABELS.l },
  { value: "xl", label: COMPLEXITY_LABELS.xl },
];

/** The table's and the properties rail's priority choices: the raw enum as `value`, its label in the interface language as the text. */
export function usePriorityOptions(): SelectOption[] {
  const L = useLabel();
  return PRIORITY_OPTIONS.map((o) => ({ ...o, label: L("issuePriority", o.value) }));
}

/** The complexity choices, `—` for none, each size's word in the interface language. */
export function useComplexityOptions(): SelectOption[] {
  const t = useCopy();
  return COMPLEXITY_OPTIONS.map((o) => (o.value ? { ...o, label: t(`issues.complexity.${o.value}` as never) } : o));
}

const isParentEdge = (k: IssueDependencyEdge["kind"]) =>
  k === "decomposes" || k === "parent";

/** A Menu item for the issue at the other end of an incoming or outgoing edge; a short id and no title where it was not enriched. */
function edgeToMenuItem(e: IssueDependencyEdge, dir: "in" | "out", navigate: (id: string) => void): MenuItem {
  const other = otherEnd(e, dir === "in" ? e.toIssueId : e.fromIssueId);
  const displayId = other.displayId ?? `#${other.id.slice(0, 6)}`;
  return { label: other.title ? `${displayId} · ${other.title}` : displayId, icon: "arrowRight", onSelect: () => navigate(other.id) };
}

/** A single readable relation chip that reveals its related issues on click.
 *  The trigger reads as a labelled pill (icon + "Blocked by 2") instead of a
 *  cryptic emoji+count; the dropdown lists the actual `ISS-X · title` issues,
 *  each navigating to that issue (ISS-366 D3). Renders nothing when empty.
 *  `tone="danger"` paints it as a red filled pill — used when the issue is
 *  actively blocked by a still-open blocker so it pops while scanning the list. */
function RelationChip({
  icon,
  label,
  items,
  tone = "muted",
}: {
  icon: IconName;
  label: string;
  items: MenuItem[];
  tone?: "muted" | "danger";
}) {
  if (items.length === 0) return null;
  const danger = tone === "danger";
  return (
    <Menu
      align="left"
      items={items}
      trigger={
        <button
          type="button"
          className={
            danger
              ? "fg-caption inline-flex items-center gap-1 rounded-pill border border-danger-9 bg-danger-3 px-1.5 py-0.5 font-medium text-danger-11 transition hover:brightness-95 focus-visible:outline-none focus-visible:shadow-focus"
              : "fg-caption inline-flex items-center gap-1 rounded-pill border border-line px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:shadow-focus"
          }
          title={label}
        >
          <Icon name={icon} size={12} />
          {label}
        </button>
      }
    />
  );
}

/** Dependency badges. Readable labelled chips (Blocked by / Blocks / Subtasks
 *  / Subtask of) that each reveal the actual related `ISS-X` issues — clickable
 *  to navigate — instead of an opaque emoji + count (ISS-366 D3). The edge data
 *  is already enriched (displayId/title/status, ISS-331). Renders nothing when
 *  the issue has no relations. */
export function DepBadges({
  deps,
  slug,
}: {
  deps: IssueDependencies | undefined;
  slug: string;
}) {
  const router = useRouter();
  const t = useCopy();
  const navigate = (otherId: string) =>
    router.push(`/projects/${slug}/issues/${otherId}`);

  const { incoming, outgoing } = liveDependencies(deps);
  const blockedBy = incoming.filter((e) => e.kind === "blocks");
  const blocks = outgoing.filter((e) => e.kind === "blocks");
  const subtasks = outgoing.filter((e) => isParentEdge(e.kind));
  const parents = incoming.filter((e) => isParentEdge(e.kind));

  const openBlockers = blockedBy.filter((e) => e.holds);

  if (
    !blockedBy.length &&
    !blocks.length &&
    !subtasks.length &&
    !parents.length
  )
    return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {openBlockers.length > 0 ? (
        <RelationChip
          icon="lock"
          tone="danger"
          label={
            openBlockers.length === 1
              ? `${t("issues.deps.blockedByOne", { key: openBlockers[0].fromDisplayId ?? t("issues.deps.anIssue") })}${openBlockers[0].fromMergedAt ? ` · ${t("issues.deps.landed")}` : ""}`
              : t("issues.deps.blockedBy", { n: openBlockers.length })
          }
          items={openBlockers.map((e) => edgeToMenuItem(e, "in", navigate))}
        />
      ) : (
        <RelationChip
          icon="lock"
          label={t("issues.deps.blockedBy", { n: blockedBy.length })}
          items={blockedBy.map((e) => edgeToMenuItem(e, "in", navigate))}
        />
      )}
      <RelationChip
        icon="arrowRight"
        label={t("issues.deps.blocks", { n: blocks.length })}
        items={blocks.map((e) => edgeToMenuItem(e, "out", navigate))}
      />
      <RelationChip
        icon="grid"
        label={subtasks.length === 1 ? t("issues.deps.subtask") : t("issues.deps.subtasks", { n: subtasks.length })}
        items={subtasks.map((e) => edgeToMenuItem(e, "out", navigate))}
      />
      <RelationChip
        icon="fork"
        label={
          parents.length > 1 ? t("issues.deps.subtaskOfN", { n: parents.length }) : t("issues.deps.subtaskOf")
        }
        items={parents.map((e) => edgeToMenuItem(e, "in", navigate))}
      />
    </span>
  );
}

/** How long the row has sat where it is. A settled row renders a dash rather
 *  than a figure, and a row past the stale threshold is told apart by its
 *  colour and its icon before the number is read at all. */
export function LastWriteCell({
  written,
}: {
  written: { ms: number; stale: boolean } | null;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  if (!written) return <span className="fg-caption">—</span>;
  const label = time.elapsed(written.ms);
  return (
    <span
      className={
        written.stale
          ? "fg-caption fg-caption-stale inline-flex items-center gap-1 tabular-nums"
          : "fg-caption inline-flex items-center gap-1 tabular-nums"
      }
      title={
        written.stale
          ? t("issues.lastWrite.stale", { age: label })
          : t("issues.lastWrite.fresh", { age: label })
      }
    >
      {written.stale && <Icon name="clock" size={12} />}
      {label}
    </span>
  );
}
