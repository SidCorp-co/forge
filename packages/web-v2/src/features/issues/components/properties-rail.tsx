"use client";

// Issue-detail properties rail (REQ-43): Properties (the requirement it delivers, priority, size,
// kind, owner, when it was opened), then what it Waits for and what it Holds up. The developer view
// adds the rest: modules, labels, branch, the merge mark (its date, and whether Forge observed the
// merge or only recorded somebody's claim of it — ISS-1126), what it carries, production, cost, and
// every other kind of relation.

import type { IssueStanding } from "@forge/contracts/issue-standing";
import { ISSUE_CATEGORY_LABELS } from "@forge/contracts/issue-vocabulary";
import Link from "next/link";
import { useState } from "react";
import { useBlockerEdit } from "../hooks";
import { formatApiError } from "@/lib/api/error";
import { Avatar, Button, enumLabel, FactsGroup, MonoTag, type SelectOption, Stat, StatusBadge } from "@/design";
import { useComplexityOptions, usePriorityOptions } from "./issue-table-row";
import { IssueRefBadge } from "./issue-ref-badge";
import { LiveReachValue } from "./live-reach-row";
import { ModuleHover } from "./module-hover";
import { MergeMarkerControl } from "./merge-marker-control";
import { RailTraceRows, Row } from "./rail-trace";
import { IssueRequirementProperty } from "./requirement-property";
import { type EditRefusal, InlineSelect } from "./inline-edit-cell";
import { creatorLabelOf, initials, liveDependencies } from "../derive";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { agentHoldsEdit, heldByAgent } from "../edit-lock";
import type {
  IssueComplexity,
  IssueCostSummary,
  IssueDependencies,
  IssueDependencyEdge,
  IssueDetail,
  IssuePriority,
  LandingShape,
  MergeMarkKind,
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

/** Total tokens an issue consumed across every session, compacted for the rail
 * (`2.4M`, `340K`). Sums input + output + cache (read/creation) — the full
 * usage rollup from `cost-summary`. Cache tokens are real consumption, so they
 * count toward the total. */
function totalTokens(cost: IssueCostSummary | undefined): number {
  if (!cost) return 0;
  return cost.inputTokens + cost.outputTokens + cost.cacheReadTokens + cost.cacheCreationTokens;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}


/** Artifacts carried between issues: the other issue's key, linked, and the artifact as marked. */
function CarriageList({ items, slug, from = false }: { items: Array<{ ref: string; key: string }>; slug: string; from?: boolean }) {
  const t = useCopy();
  return (
    <ul className="grid gap-1" data-testid={from ? "issue-carries" : "issue-carried-by"}>
      {items.map((c) => (
        <li key={`${c.key}:${c.ref}`} className="grid justify-items-end gap-0.5">
          <Link className="font-mono text-12 text-link hover:underline" href={issueHref(slug, c.key)}>
            {from ? t("issues.rail.carriesFrom", { issue: c.key }) : c.key}
          </Link>
          <span className="break-all font-mono text-11-5 text-subtle">{c.ref}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * ISS-1126 — which kind of merge mark this is, beside the date.
 *
 * `mergedAt` alone reads as "shipped" whichever it is. An `asserted` mark means Forge holds no
 * record of the merge and took somebody's word for it; an `observed` one carries the commit Forge
 * read for itself, off a change request or the repository. Shown apart from the date because a reader deciding
 * whether the work is really out there is asking this question and not the other one.
 *
 * The kind is core's reading (`merge-record.ts`), never re-derived here. An older server that sends
 * no `mergeMark` renders nothing rather than guessing.
 */
function MergeMarkBadge({
  mark,
  commitSha,
  landing,
  landingShape,
}: {
  mark?: MergeMarkKind;
  commitSha?: string | null;
  landing?: string | null;
  landingShape?: LandingShape | null;
}) {
  const t = useCopy();
  if (mark === "landed") {
    // ISS-1327 — the landing is the evidence, so it is shown as text rather than kept on a hover
    // that keyboard, touch and screen-reader users never reach.
    return (
      <>
        <StatusBadge family="mergeMark" value="landed" />
        {landing && (
          <span className="fg-body-sm min-w-0 break-all font-mono text-muted" data-testid="merged-landing">
            {landing}
          </span>
        )}
      </>
    );
  }
  if (mark === "observed") {
    return (
      <span title={t("issues.merge.observed", { sha: commitSha ?? t("issues.merge.aCommit") })}>
        <StatusBadge family="mergeMark" value="observed" />
      </span>
    );
  }
  if (mark === "asserted") {
    return (
      <span
        title={
          // Outside git no change request is the normal record; what the mark lacks is a landing.
          landingShape === "outside_git"
            ? t("issues.merge.noLanding")
            : t("issues.merge.asserted")
        }
      >
        <StatusBadge family="mergeMark" value="asserted" />
      </span>
    );
  }
  return null;
}

/** A relation section (Blocked by / Blocks / Parent / Subtasks / Duplicates /
 *  Related). The section heading conveys the relationship, so each edge renders
 *  only a clickable `ISS-X` badge for the OTHER endpoint (with a status tone
 *  dot when enriched) — falling back to a short id when the server didn't
 *  enrich the edge. Raw `kind` wire values are never shown (ISS-349). */
function DepList({
  edges,
  self,
  slug,
  label,
  expired = false,
}: {
  edges: IssueDependencyEdge[];
  self: string;
  slug: string;
  label: string;
  /** Retracted edges: greyed, each naming its kind and "expired", so none reads as in force. */
  expired?: boolean;
}) {
  if (edges.length === 0) return null;
  return (
    <div className={expired ? "py-2 opacity-60" : "py-2"} data-expired={expired || undefined}>
      <p className="fg-caption mb-1">{label}</p>
      <div className="flex flex-col items-end gap-1.5">
        {edges.map((e) => {
          if (expired) return <ExpiredEdge key={e.id} edge={e} self={self} />;
          const isFromSelf = e.fromIssueId === self;
          const other = isFromSelf ? e.toIssueId : e.fromIssueId;
          const otherDisplayId = isFromSelf ? e.toDisplayId : e.fromDisplayId;
          const otherTitle = isFromSelf ? e.toTitle : e.fromTitle;
          const otherStatus = isFromSelf ? e.toStatus : e.fromStatus;
          return otherDisplayId ? (
            <IssueRefBadge
              key={e.id}
              id={other}
              slug={slug}
              displayId={otherDisplayId}
              title={otherTitle}
              status={otherStatus}
              showTitle
            />
          ) : (
            <MonoTag key={e.id} hue={e.kind === "blocks" ? "flame" : "neutral"}>
              {other.slice(0, 8)}
            </MonoTag>
          );
        })}
      </div>
    </div>
  );
}

function ExpiredEdge({ edge, self }: { edge: IssueDependencyEdge; self: string }) {
  const t = useCopy();
  const isFromSelf = edge.fromIssueId === self;
  const other = isFromSelf ? edge.toIssueId : edge.fromIssueId;
  const otherDisplayId = (isFromSelf ? edge.toDisplayId : edge.fromDisplayId) ?? other.slice(0, 8);
  return (
    <span className="fg-caption text-muted line-through decoration-1">
      {t(`issues.relation.${edge.kind}`)} {otherDisplayId} · {t("issues.relation.expired")}
    </span>
  );
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

/** One kind of relation as rows of key and title; more than two show the first two and a count that opens the rest. */
function EdgeRows({ edges, self, slug, label, testId, edit }: { edges: IssueDependencyEdge[]; self: string; slug: string; label: string; testId: string; edit?: BlockerEdit }) {
  const t = useCopy();
  const [all, setAll] = useState(false);
  if (edges.length === 0 && !edit) return null;
  const shown = all ? edges : edges.slice(0, EDGES_SHOWN);
  return (
    <section className="pt-4" data-testid={testId}>
      <h3 className="mb-1 text-13 font-semibold text-muted">{label}</h3>
      <ul className="divide-y divide-line-subtle">
        {shown.map((e) => {
          const isFromSelf = e.fromIssueId === self;
          const other = isFromSelf ? e.toIssueId : e.fromIssueId;
          const displayId = isFromSelf ? e.toDisplayId : e.fromDisplayId;
          const title = isFromSelf ? e.toTitle : e.fromTitle;
          const status = isFromSelf ? e.toStatus : e.fromStatus;
          return (
            <li key={e.id} className="min-w-0 py-1.5">
              {displayId ? (
                <IssueRefBadge id={other} slug={slug} displayId={displayId} title={title} status={status} showTitle />
              ) : (
                <MonoTag>{other.slice(0, 8)}</MonoTag>
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
  const modules = (issue.labels ?? []).filter((l) => l.kind === "module");
  const plainLabels = (issue.labels ?? []).filter((l) => l.kind !== "module");
  const primaryModule = modules.find((m) => m.isPrimary);
  const secondaryModules = modules.filter((m) => !m.isPrimary);
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
  const tokens = totalTokens(cost);
  const hasModule = primaryModule !== undefined || secondaryModules.length > 0;
  const offerModule = !hasModule && onEditModules !== undefined;
  const offerMerge = !issue.mergedAt && canMarkMerged === true;
  const ownerName = owner ? (owner.name ?? t("issues.facts.unknown")) : creatorLabelOf(issue);
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
          <Row label={t("issues.field.priority")}>
            <InlineSelect
              ariaLabel={t("issues.field.priority")}
              value={issue.priority}
              options={priorityOptions}
              disabled={pending}
              refusal={refusal}
              onCommit={(p) => onPatch({ priority: p as IssuePriority })}
              className="w-36"
            />
          </Row>
          <Row label={t("issues.field.size")}>
            <InlineSelect
              ariaLabel={t("issues.field.size")}
              value={issue.complexity ?? ""}
              options={complexityOptions}
              disabled={pending}
              refusal={refusal}
              onCommit={(c) => onPatch({ complexity: c === "" ? null : (c as IssueComplexity) })}
              className="w-36"
            />
          </Row>
          <Row label={t("issues.field.kind")}>
            <InlineSelect
              ariaLabel={t("issues.field.kind")}
              value={issue.category ?? ""}
              options={categoryOptions(issue.category ?? null, language, t("issues.category.notSet"))}
              disabled={pending}
              refusal={refusal}
              onCommit={(c) => onPatch({ category: c === "" ? null : c })}
              className="w-36"
            />
          </Row>
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
          {developer && hasModule ? (
            <Row label={t("issues.field.module")}>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {primaryModule && <ModuleHover projectId={issue.projectId} slug={slug} module={primaryModule} primary />}
                {secondaryModules.map((m) => (
                  <ModuleHover key={m.id} projectId={issue.projectId} slug={slug} module={m} primary={false} />
                ))}
                {onEditModules && (
                  <Button variant="ghost" size="sm" icon="settings" onClick={onEditModules}>
                    {t("issues.rail.edit")}
                  </Button>
                )}
              </div>
            </Row>
          ) : null}
          {developer && plainLabels.length > 0 ? (
            <Row label={t("issues.rail.labels")}>
              <div className="flex flex-wrap justify-end gap-1.5">
                {plainLabels.map((l) => (
                  <MonoTag key={l.id}>{l.name}</MonoTag>
                ))}
              </div>
            </Row>
          ) : null}
          {developer ? (
            <Row label={t("issues.rail.branch")}>
              <MonoTag>{issue.displayId}</MonoTag>
            </Row>
          ) : null}
          {developer && issue.mergedAt ? (
            <Row label={t("issues.rail.merged")}>
              <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                <span className="fg-body-sm whitespace-nowrap font-mono text-muted">{day(issue.mergedAt)}</span>
                <MergeMarkBadge
                  mark={issue.mergeMark}
                  commitSha={issue.mergedCommitSha}
                  landing={issue.mergedLanding}
                  landingShape={issue.landingShape}
                />
                {canMarkMerged && (
                  <MergeMarkerControl
                    issueId={issue.id}
                    mergedAt={issue.mergedAt}
                    suggestedTarget={issue.displayId}
                    landingShape={issue.landingShape}
                  />
                )}
              </div>
            </Row>
          ) : null}
          {developer && issue.carriage && issue.carriage.carriedBy.length > 0 ? (
            <Row label={t("issues.rail.carriedBy")}>
              <CarriageList items={issue.carriage.carriedBy.map((c) => ({ ref: c.ref, key: c.issue }))} slug={slug} />
            </Row>
          ) : null}
          {developer && issue.carriage && issue.carriage.carries.length > 0 ? (
            <Row label={t("issues.rail.carries")}>
              <CarriageList items={issue.carriage.carries.map((c) => ({ ref: c.ref, key: c.from }))} slug={slug} from />
            </Row>
          ) : null}
          {developer && issue.liveReach ? (
            <Row label={t("issues.rail.production")}>
              <LiveReachValue reach={issue.liveReach} />
            </Row>
          ) : null}
          {developer && cost && cost.estimatedCost > 0 ? (
            <Row label={t("issues.rail.cost")}>
              <Stat icon="dollar">{`$${cost.estimatedCost.toFixed(2)}`}</Stat>
            </Row>
          ) : null}
          {developer && tokens > 0 ? (
            <Row label={t("issues.rail.tokens")}>
              <Stat icon="cpu">
                <span title={t("issues.rail.tokensExact", { n: time.number(tokens) })}>{fmtTokens(tokens)}</span>
              </Stat>
            </Row>
          ) : null}
          {developer && issue.reopenCount > 0 ? (
            <Row label={t("issues.rail.reopens")}>
              <span className="fg-body-sm font-mono text-muted">{issue.reopenCount}</span>
            </Row>
          ) : null}
          {developer && (offerModule || offerMerge) ? (
            <Row label={t("issues.rail.notSet")}>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {offerModule && (
                  <Button variant="ghost" size="sm" icon="settings" onClick={onEditModules}>
                    {t("issues.rail.setModule")}
                  </Button>
                )}
                {offerMerge && (
                  <MergeMarkerControl
                    issueId={issue.id}
                    mergedAt={null}
                    suggestedTarget={issue.displayId}
                    landingShape={issue.landingShape}
                  />
                )}
              </div>
            </Row>
          ) : null}
        </div>
      </FactsGroup>
      <EdgeRows edges={blockedBy} self={issue.id} slug={slug} label={t("issues.rail.waitsFor")} testId="rail-waits-for" edit={edit} />
      <EdgeRows edges={blocks} self={issue.id} slug={slug} label={t("issues.rail.holdsUp")} testId="rail-holds-up" />
      {developer ? (
        <>
          <DepList edges={parents} self={issue.id} slug={slug} label={t("issues.rail.parent")} />
          <DepList edges={subtasks} self={issue.id} slug={slug} label={t("issues.rail.subtasks")} />
          <DepList edges={duplicates} self={issue.id} slug={slug} label={t("issues.rail.duplicates")} />
          <DepList edges={related} self={issue.id} slug={slug} label={t("issues.rail.related")} />
          <DepList edges={expired} self={issue.id} slug={slug} label={t("issues.rail.expired")} expired />
        </>
      ) : null}
    </div>
  );
}
