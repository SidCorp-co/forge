"use client";

// The issue's properties only a developer reads: modules, labels, branch, merge mark, carriage,
// production reach, cost, tokens and reopens, with the acts that set a missing module or merge mark.

import Link from "next/link";
import { Button, MonoTag, Stat, StatusBadge } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import type { IssueCostSummary, IssueDetail, LandingShape, MergeMarkKind } from "../types";
import { LiveReachValue } from "./live-reach-row";
import { MergeMarkerControl } from "./merge-marker-control";
import { ModuleHover } from "./module-hover";
import { Row } from "./rail-trace";

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
          <span className="break-all font-mono text-12 text-subtle">{c.ref}</span>
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
            ? t("issues.merge.landingMissing")
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

export function DeveloperProperties({
  issue,
  slug,
  cost,
  canMarkMerged,
  onEditModules,
}: {
  issue: IssueDetail;
  slug: string;
  cost: IssueCostSummary | undefined;
  canMarkMerged?: boolean;
  onEditModules?: () => void;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  const day = (iso: string) => (Number.isNaN(new Date(iso).getTime()) ? "—" : time.date(iso));
  const modules = (issue.labels ?? []).filter((l) => l.kind === "module");
  const plainLabels = (issue.labels ?? []).filter((l) => l.kind !== "module");
  const primaryModule = modules.find((m) => m.isPrimary);
  const secondaryModules = modules.filter((m) => !m.isPrimary);
  const tokens = totalTokens(cost);
  const hasModule = primaryModule !== undefined || secondaryModules.length > 0;
  const offerModule = !hasModule && onEditModules !== undefined;
  const offerMerge = !issue.mergedAt && canMarkMerged === true;
  return (
    <>
      {hasModule ? (
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
      {plainLabels.length > 0 ? (
        <Row label={t("issues.rail.labels")}>
          <div className="flex flex-wrap justify-end gap-1.5">
            {plainLabels.map((l) => (
              <MonoTag key={l.id}>{l.name}</MonoTag>
            ))}
          </div>
        </Row>
      ) : null}
      <Row label={t("issues.rail.branch")}>
        <MonoTag>{issue.displayId}</MonoTag>
      </Row>
      {issue.mergedAt ? (
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
      {issue.carriage && issue.carriage.carriedBy.length > 0 ? (
        <Row label={t("issues.rail.carriedBy")}>
          <CarriageList items={issue.carriage.carriedBy.map((c) => ({ ref: c.ref, key: c.issue }))} slug={slug} />
        </Row>
      ) : null}
      {issue.carriage && issue.carriage.carries.length > 0 ? (
        <Row label={t("issues.rail.carries")}>
          <CarriageList items={issue.carriage.carries.map((c) => ({ ref: c.ref, key: c.from }))} slug={slug} from />
        </Row>
      ) : null}
      {issue.liveReach ? (
        <Row label={t("issues.rail.production")}>
          <LiveReachValue reach={issue.liveReach} />
        </Row>
      ) : null}
      {cost && cost.estimatedCost > 0 ? (
        <Row label={t("issues.rail.cost")}>
          <Stat icon="dollar">{`$${cost.estimatedCost.toFixed(2)}`}</Stat>
        </Row>
      ) : null}
      {tokens > 0 ? (
        <Row label={t("issues.rail.tokens")}>
          <Stat icon="cpu">
            <span title={t("issues.rail.tokensExact", { n: time.number(tokens) })}>{fmtTokens(tokens)}</span>
          </Stat>
        </Row>
      ) : null}
      {issue.reopenCount > 0 ? (
        <Row label={t("issues.rail.reopens")}>
          <span className="fg-body-sm font-mono text-muted">{issue.reopenCount}</span>
        </Row>
      ) : null}
      {(offerModule || offerMerge) ? (
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
    </>
  );
}
