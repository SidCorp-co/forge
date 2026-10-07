"use client";

// Issue-detail properties rail. Read + inline-edit of the core fields, plus a
// cost rollup, the merge mark (its date, and whether Forge observed the merge or
// only recorded somebody's claim of it — ISS-1126), the ISS-<seq> branch
// convention, and dependency edges (rendered as clickable `ISS-X` badges linking
// to the related issue — ISS-331).

import type { IssueMove } from "@forge/contracts/issue-machine";
import { ISSUE_CATEGORY_LABELS } from "@forge/contracts/issue-vocabulary";
import Link from "next/link";
import { type ComponentProps, useId } from "react";
import { Avatar, Button, enumLabel, MonoTag, type SelectOption, Stat, StatusBadge, StatusChip } from "@/design";
import { EtaInline } from "@/features/forecast/components/eta-cell";
import { etaOfForecast } from "@/features/forecast/eta";
import { ETA_COPY } from "@/features/forecast/eta-copy";
import { useEtaClock, useIssueForecast } from "@/features/forecast/hooks";
import { useComplexityOptions, usePriorityOptions } from "./issue-table-row";
import { IssueRefBadge } from "./issue-ref-badge";
import { LiveReachValue } from "./live-reach-row";
import { MergeMarkerControl } from "./merge-marker-control";
import { type EditRefusal, InlineSelect, StatusEdit } from "./inline-edit-cell";
import { creatorLabelOf, initials, liveDependencies, runStatusChip } from "../derive";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { agentHoldsEdit, heldByAgent } from "../edit-lock";
import type {
  IssueComplexity,
  IssueCostSummary,
  IssueDependencies,
  IssueDependencyEdge,
  IssueDetail,
  IssuePriority,
  IssueStatus,
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="fg-caption flex-none">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
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
  /** The reader holds no write on this project: the fields say so rather than grey out silently. */
  readOnly?: boolean | undefined;
  onPatch: (body: {
    priority?: IssuePriority;
    complexity?: IssueComplexity | null;
    category?: string | null;
  }) => void;
  onTransition: (toStatus: IssueStatus) => void;
  /** Open the module picker. Absent for a reader who cannot write. */
  onEditModules?: (() => void) | undefined;
  /** ISS-791 — offer the shipped-work claim. False for a reader who cannot write. */
  canMarkMerged?: boolean | undefined;
  /** What a person owes this issue, so the status control at a park offers that decision first. */
  park?: ComponentProps<typeof StatusEdit>["park"];
  /** Core's moves from the issue's status (`IssueStanding.moves`). */
  moves: readonly IssueMove[];
}

export function PropertiesRail({
  issue,
  slug,
  cost,
  deps,
  pending,
  readOnly = false,
  onPatch,
  onTransition,
  onEditModules,
  canMarkMerged,
  park,
  moves,
}: PropertiesRailProps) {
  const language = useInterfaceLanguage();
  const forecast = useIssueForecast(issue.projectId, issue.displayId).data?.forecast;
  const clock = useEtaClock();
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
  const refusalId = useId();
  const t = useCopy();
  const time = useTimeFormat();
  const priorityOptions = usePriorityOptions();
  const complexityOptions = useComplexityOptions();
  const day = (iso: string) => (Number.isNaN(new Date(iso).getTime()) ? "—" : time.date(iso));
  const refusal: EditRefusal | null = held
    ? { id: refusalId, text: agentHoldsEdit(t) }
    : readOnly
      ? { id: refusalId, text: t("issues.edit.readOnly") }
      : null;
  const runChip = runStatusChip(issue);
  const tokens = totalTokens(cost);
  const hasModule = primaryModule !== undefined || secondaryModules.length > 0;
  // An empty field renders no row; one whose action this reader holds keeps the action, on the shared `Not set` row.
  const offerModule = !hasModule && onEditModules !== undefined;
  const offerMerge = !issue.mergedAt && canMarkMerged === true;
  return (
    <div className="divide-y divide-line-subtle">
      {refusal && (
        <p id={refusal.id} role="status" className="fg-body-sm py-2 text-subtle">
          {refusal.text}
        </p>
      )}
      <Row label={t("issues.field.status")}>
        <StatusEdit
          status={issue.status}
          step={issue.workState?.step ?? null}
          moves={moves}
          agentStatus={issue.agentStatus}
          disabled={pending || readOnly}
          onTransition={onTransition}
          park={park}
        />
      </Row>
      {forecast && forecast.kind !== "landed" && forecast.kind !== "ended" && (
        <Row label={ETA_COPY[clock.lang].header}>
          <EtaInline eta={etaOfForecast(forecast, clock)} clock={clock} />
        </Row>
      )}
      {issue.shippedIn ? (
        <div data-testid="rail-shipped-in">
          <Row label={t("issues.shippedIn")}>
            <Link href={releaseHref(slug, issue.shippedIn.version)} className="font-mono text-12 text-link hover:underline">
              {issue.shippedIn.version}
            </Link>
          </Row>
        </div>
      ) : null}
      {runChip && (
        <Row label={t("issues.rail.run")}>
          <StatusChip status={runChip} size="sm" domain="session" />
        </Row>
      )}
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
      <Row label={t("issues.field.complexity")}>
        <InlineSelect
          ariaLabel={t("issues.field.complexity")}
          value={issue.complexity ?? ""}
          options={complexityOptions}
          disabled={pending}
          refusal={refusal}
          onCommit={(c) => onPatch({ complexity: c === "" ? null : (c as IssueComplexity) })}
          className="w-36"
        />
      </Row>
      <Row label={t("issues.category.label")}>
        <InlineSelect
          ariaLabel={t("issues.category.label")}
          value={issue.category ?? ""}
          options={categoryOptions(issue.category ?? null, language, t("issues.category.notSet"))}
          disabled={pending}
          refusal={refusal}
          onCommit={(c) => onPatch({ category: c === "" ? null : c })}
          className="w-36"
        />
      </Row>
      <Row label={t("issues.field.creator")}>
        <div className="flex items-center justify-end gap-2">
          <Avatar initials={initials(creatorLabelOf(issue))} size={22} />
          <span className="fg-body-sm truncate text-fg" title={creatorLabelOf(issue)}>
            {creatorLabelOf(issue)}
          </span>
        </div>
      </Row>
      {hasModule && (
        <Row label={t("issues.field.module")}>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {primaryModule && <MonoTag hue="cobalt">{primaryModule.name}</MonoTag>}
            {secondaryModules.map((m) => (
              <MonoTag key={m.id}>{m.name}</MonoTag>
            ))}
            {onEditModules && (
              <Button variant="ghost" size="sm" icon="settings" onClick={onEditModules}>
                {t("issues.rail.edit")}
              </Button>
            )}
          </div>
        </Row>
      )}
      {plainLabels.length > 0 && (
        <Row label={t("issues.rail.labels")}>
          <div className="flex flex-wrap justify-end gap-1.5">
            {plainLabels.map((l) => (
              <MonoTag key={l.id}>{l.name}</MonoTag>
            ))}
          </div>
        </Row>
      )}
      <Row label={t("issues.rail.branch")}>
        <MonoTag>{issue.displayId}</MonoTag>
      </Row>
      {issue.mergedAt && (
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
      )}
      {issue.carriage && issue.carriage.carriedBy.length > 0 && (
        <Row label={t("issues.rail.carriedBy")}>
          <CarriageList items={issue.carriage.carriedBy.map((c) => ({ ref: c.ref, key: c.issue }))} slug={slug} />
        </Row>
      )}
      {issue.carriage && issue.carriage.carries.length > 0 && (
        <Row label={t("issues.rail.carries")}>
          <CarriageList items={issue.carriage.carries.map((c) => ({ ref: c.ref, key: c.from }))} slug={slug} from />
        </Row>
      )}
      {issue.liveReach && (
        <Row label={t("issues.rail.production")}>
          <LiveReachValue reach={issue.liveReach} />
        </Row>
      )}
      {cost && cost.estimatedCost > 0 && (
        <Row label={t("issues.rail.cost")}>
          <Stat icon="dollar">{`$${cost.estimatedCost.toFixed(2)}`}</Stat>
        </Row>
      )}
      {tokens > 0 && (
        <Row label={t("issues.rail.tokens")}>
          <Stat icon="cpu">
            <span title={t("issues.rail.tokensExact", { n: time.number(tokens) })}>{fmtTokens(tokens)}</span>
          </Stat>
        </Row>
      )}
      <Row label={t("issues.rail.created")}>
        <span className="fg-body-sm whitespace-nowrap font-mono text-muted">{day(issue.createdAt)}</span>
      </Row>
      <Row label={t("issues.rail.reopens")}>
        <span className="fg-body-sm font-mono text-muted">{issue.reopenCount}</span>
      </Row>
      {(offerModule || offerMerge) && (
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
      )}
      <DepList edges={blockedBy} self={issue.id} slug={slug} label={t("issues.rail.blockedBy")} />
      <DepList edges={blocks} self={issue.id} slug={slug} label={t("issues.rail.blocks")} />
      <DepList edges={parents} self={issue.id} slug={slug} label={t("issues.rail.parent")} />
      <DepList edges={subtasks} self={issue.id} slug={slug} label={t("issues.rail.subtasks")} />
      <DepList edges={duplicates} self={issue.id} slug={slug} label={t("issues.rail.duplicates")} />
      <DepList edges={related} self={issue.id} slug={slug} label={t("issues.rail.related")} />
      <DepList edges={expired} self={issue.id} slug={slug} label={t("issues.rail.expired")} expired />
    </div>
  );
}
