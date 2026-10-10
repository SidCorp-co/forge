"use client";

// Issue-detail properties rail (REQ-43): Properties (the requirement it delivers, priority, size,
// kind, owner, when it was opened), then what it Waits for and what it Holds up. The developer view
// adds the rest: modules, labels, branch, the merge mark (its date, and whether Forge observed the
// merge or only recorded somebody's claim of it — ISS-1126), what it carries, production, cost, and
// every other kind of relation.

import type { IssueStanding } from "@forge/contracts/issue-standing";
import { ISSUE_CATEGORY_LABELS } from "@forge/contracts/issue-vocabulary";
import { useState } from "react";
import { useBlockerEdit } from "../hooks";
import { formatApiError } from "@/lib/api/error";
import { Avatar, enumLabel, FactsGroup, MonoTag, type SelectOption } from "@/design";
import { useComplexityOptions, usePriorityOptions } from "./issue-table-row";
import { IssueRefBadge } from "./issue-ref-badge";
import { DeveloperProperties } from "./developer-properties";
import { RailTraceRows, Row } from "./rail-trace";
import { IssueRequirementProperty } from "./requirement-property";
import { type EditRefusal, InlineSelect } from "./inline-edit-cell";
import { creatorLabelOf, initials, liveDependencies, otherEnd } from "../derive";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { agentHoldsEdit, heldByAgent } from "../edit-lock";
import type {
  IssueComplexity,
  IssueCostSummary,
  IssueDependencies,
  IssueDependencyEdge,
  IssueDetail,
  IssuePriority,
} from "../types";

// one option per word the category takes in practice: `documentation` and `tests` read as `docs` and `test`
const CATEGORY_VALUES = Object.entries(ISSUE_CATEGORY_LABELS)
  .filter(([, label], i, all) => all.findIndex(([, l]) => l === label) === i)
  .map(([value]) => value);

/** The categories offered, the issue's own first when it is a word outside the usual ones. */
function categoryOptions(current: string | null, language: string, notSet: string): SelectOption[] {
  const values = current && !CATEGORY_VALUES.includes(current) ? [current, ...CATEGORY_VALUES] : CATEGORY_VALUES;
  return [
    { value: "", label: notSet },
    ...values.map((value) => ({ value, label: enumLabel("category", value, language) })),
  ];
}

interface PropertiesRailProps {
  issue: IssueDetail;
  /** Project slug — for building links from relation badges to related issues. */
  slug: string;
  cost: IssueCostSummary | undefined;
  deps: IssueDependencies | undefined;
  pending: boolean;
  /** The reader holds no write on this project: the fields are disabled, and say why on hover. */
  readOnly?: boolean | undefined;
  onPatch: (body: {
    priority?: IssuePriority;
    complexity?: IssueComplexity | null;
    category?: string | null;
  }) => void;
  /** Open the module picker. Absent for a reader who cannot write. */
  onEditModules?: (() => void) | undefined;
  /** ISS-791 — offer the shipped-work claim. False for a reader who cannot write. */
  canMarkMerged?: boolean | undefined;
  /** The requirement the issue delivers (`IssueStanding.requirement.key`), null while none; undefined until the standing is read. */
  requirementKey?: string | null | undefined;
  /** Who owns the issue now (`IssueStanding.owner`); the creator where the standing names none. */
  owner?: { name: string | null; kind: "human" | "agent" } | null | undefined;
  /** The issue's standing, for the trace rows (`rail-trace.tsx`); undefined until it is read. */
  standing?: IssueStanding | undefined;
  /** The developer view: every row the person's view leaves out. */
  developer?: boolean;
}

interface BlockerEdit {
  add: (key: string) => void;
  remove: (edgeId: string) => void;
  busy: boolean;
  error: string | null;
}

/** One line to name the issue this one waits for; the refusal reads beneath it. */
function AddBlocker({ edit }: { edit: BlockerEdit }) {
  const t = useCopy();
  const [key, setKey] = useState("");
  const k = key.trim().toUpperCase();
  return (
    <form
      className="pt-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (k) {
          edit.add(k);
          setKey("");
        }
      }}
    >
      <div className="flex items-center gap-2 border-t border-line-subtle pt-1.5">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t("issues.rail.waitOnPlaceholder")}
          aria-label={t("issues.rail.waitOn")}
          className="h-7 min-w-0 flex-1 bg-transparent text-13 outline-none"
        />
        <button type="submit" disabled={edit.busy || !k} className="text-13 text-accent-text disabled:opacity-50">
          {t("issues.rail.waitOn")}
        </button>
      </div>
      {edit.error ? <p className="pt-1 text-12 text-danger">{edit.error}</p> : null}
    </form>
  );
}

/** Edges shown before "N more": the rail is a glance, and the issue's own page lists the rest. */
const EDGES_SHOWN = 2;

/** One kind of relation as rows of key and title; more than two show the first two and a count that opens the rest. A retracted edge is greyed and says so, never reading as in force. */
function EdgeRows({ edges, self, slug, label, testId, edit, expired = false }: { edges: IssueDependencyEdge[]; self: string; slug: string; label: string; testId?: string; edit?: BlockerEdit; expired?: boolean }) {
  const t = useCopy();
  const [all, setAll] = useState(false);
  if (edges.length === 0 && !edit) return null;
  const shown = all ? edges : edges.slice(0, EDGES_SHOWN);
  return (
    <section className={expired ? "pt-4 opacity-60" : "pt-4"} data-testid={testId} data-expired={expired || undefined}>
      <h3 className="mb-1 text-13 font-semibold text-muted">{label}</h3>
      <ul className="divide-y divide-line-subtle">
        {shown.map((e) => {
          const other = otherEnd(e, self);
          return (
            <li key={e.id} className="min-w-0 py-1.5">
              {expired ? (
                <span className="fg-caption text-muted line-through decoration-1">
                  {t(`issues.relation.${e.kind}`)} {other.displayId ?? other.id.slice(0, 8)} · {t("issues.relation.expired")}
                </span>
              ) : other.displayId ? (
                <IssueRefBadge id={other.id} slug={slug} displayId={other.displayId} title={other.title} status={other.status} showTitle />
              ) : (
                <MonoTag>{other.id.slice(0, 8)}</MonoTag>
              )}
              {edit ? (
                <button type="button" disabled={edit.busy} onClick={() => edit.remove(e.id)} className="ml-2 text-12 text-muted hover:text-fg">
                  {t("issues.rail.retract")}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {edit ? <AddBlocker edit={edit} /> : null}
      {edges.length > EDGES_SHOWN && !all ? (
        <button type="button" onClick={() => setAll(true)} className="py-1.5 text-13 text-muted hover:text-fg">
          {t("issues.rail.more", { n: edges.length - EDGES_SHOWN })}
        </button>
      ) : null}
    </section>
  );
}

export function PropertiesRail({
  issue,
  slug,
  cost,
  deps,
  pending,
  readOnly = false,
  onPatch,
  onEditModules,
  canMarkMerged,
  requirementKey,
  owner,
  standing,
  developer = false,
}: PropertiesRailProps) {
  const language = useInterfaceLanguage();
  const blockers = useBlockerEdit(issue.id, issue.projectId);
  const edit: BlockerEdit | undefined = readOnly
    ? undefined
    : {
        add: (key) => blockers.add.mutate(key),
        remove: (id) => blockers.remove.mutate(id),
        busy: blockers.add.isPending || blockers.remove.isPending,
        error: blockers.add.error ? formatApiError(blockers.add.error) : blockers.remove.error ? formatApiError(blockers.remove.error) : null,
      };
  const { incoming, outgoing } = liveDependencies(deps);
  const expired = [...(deps?.incoming ?? []), ...(deps?.outgoing ?? [])].filter((e) => e.expired);
  const isDecompose = (e: IssueDependencyEdge) => e.kind === "decomposes" || e.kind === "parent";
  const blockedBy = incoming.filter((e) => e.kind === "blocks");
  const blocks = outgoing.filter((e) => e.kind === "blocks");
  const parents = incoming.filter(isDecompose);
  const subtasks = outgoing.filter(isDecompose);
  const duplicates = [...incoming, ...outgoing].filter((e) => e.kind === "duplicates");
  const related = [...incoming, ...outgoing].filter((e) => e.kind === "relates");
  const held = heldByAgent(issue.status, issue.agentStatus);
  const t = useCopy();
  const time = useTimeFormat();
  const priorityOptions = usePriorityOptions();
  const complexityOptions = useComplexityOptions();
  const day = (iso: string) => (Number.isNaN(new Date(iso).getTime()) ? "—" : time.date(iso));
  // said on hover only: the page never states a lock until someone reaches for the field it holds
  const refusal: EditRefusal | null = held
    ? { text: agentHoldsEdit(t) }
    : readOnly
      ? { text: t("issues.edit.readOnly") }
      : null;
  const ownerName = owner ? (owner.name ?? t("issues.facts.unknown")) : creatorLabelOf(issue);
  const selects = [
    { label: t("issues.field.priority"), value: issue.priority as string, options: priorityOptions, commit: (p: string) => onPatch({ priority: p as IssuePriority }) },
    { label: t("issues.field.size"), value: issue.complexity ?? "", options: complexityOptions, commit: (c: string) => onPatch({ complexity: c === "" ? null : (c as IssueComplexity) }) },
    { label: t("issues.field.kind"), value: issue.category ?? "", options: categoryOptions(issue.category ?? null, language, t("issues.category.notSet")), commit: (c: string) => onPatch({ category: c === "" ? null : c }) },
  ];
  return (
    <div data-testid="issue-properties">
      <FactsGroup title={t("issues.rail.properties")} testId="facts-properties">
        <div className="divide-y divide-line-subtle">
          {requirementKey !== undefined ? (
            <Row label={t("issues.facts.requirement")}>
              <IssueRequirementProperty projectId={issue.projectId} slug={slug} issueKey={issue.displayId} current={requirementKey} disabled={readOnly} />
            </Row>
          ) : null}
          <RailTraceRows issue={issue} slug={slug} standing={standing} />
          {selects.map((f) => (
            <Row key={f.label} label={f.label}>
              <InlineSelect ariaLabel={f.label} value={f.value} options={f.options} disabled={pending} refusal={refusal} onCommit={f.commit} className="w-36" />
            </Row>
          ))}
          <Row label={t("issues.facts.owner")}>
            <div className="flex min-w-0 items-center justify-end gap-2">
              <Avatar initials={initials(ownerName)} size={22} />
              <span className="fg-body-sm truncate text-fg" title={ownerName}>
                {ownerName}
              </span>
            </div>
          </Row>
          <Row label={t("issues.rail.opened")}>
            <span className="fg-body-sm whitespace-nowrap font-mono text-muted">{day(issue.createdAt)}</span>
          </Row>
          {developer ? (
            <DeveloperProperties issue={issue} slug={slug} cost={cost} canMarkMerged={canMarkMerged} onEditModules={onEditModules} />
          ) : null}
        </div>
      </FactsGroup>
      <EdgeRows edges={blockedBy} self={issue.id} slug={slug} label={t("issues.rail.waitsFor")} testId="rail-waits-for" edit={edit} />
      <EdgeRows edges={blocks} self={issue.id} slug={slug} label={t("issues.rail.holdsUp")} testId="rail-holds-up" />
      {developer ? (
        <>
          <EdgeRows edges={parents} self={issue.id} slug={slug} label={t("issues.rail.parent")} />
          <EdgeRows edges={subtasks} self={issue.id} slug={slug} label={t("issues.rail.subtasks")} />
          <EdgeRows edges={duplicates} self={issue.id} slug={slug} label={t("issues.rail.duplicates")} />
          <EdgeRows edges={related} self={issue.id} slug={slug} label={t("issues.rail.related")} />
          <EdgeRows edges={expired} self={issue.id} slug={slug} label={t("issues.rail.expired")} expired />
        </>
      ) : null}
    </div>
  );
}
