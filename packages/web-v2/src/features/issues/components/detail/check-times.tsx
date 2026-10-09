"use client";

import Link from "next/link";
import type { CheckKindTime, IssueCheckRunView } from "@forge/contracts/check-runs";
import { EmptyPanelLine, ViewHeading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { agentsListHref, runHref } from "@/lib/routes/agents";
import { useIssueChecks } from "../../checks-api";
import type { IssueAgentSession } from "../../types";
import { fmtDuration } from "../step-artifact-card";

const took = (ms: number, t: Copy) => fmtDuration(ms / 1000, t);
const kindLabel = (kind: string, t: Copy) => t(`issues.checks.kind.${kind}` as ProductCopyKey);

/** One kind of check: how many ran, the time they took together, and the slowest. */
function KindRow({ kind, t }: { kind: CheckKindTime; t: Copy }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-13" data-testid="check-kind" data-kind={kind.kind}>
      <span className="w-28 flex-none fg-label">{kindLabel(kind.kind, t)}</span>
      {kind.checks === 0 ? (
        <span className="text-subtle">{t("issues.checks.noneOfKind")}</span>
      ) : (
        <>
          <span className="tabular-nums">{took(kind.totalMs, t)}</span>
          <span className="text-12 text-muted">{kind.checks === 1 ? t("issues.checks.count.one") : t("issues.checks.count.many", { n: kind.checks })}</span>
          {kind.slowest ? (
            <span className="min-w-0 truncate text-12 text-muted">
              {t("issues.checks.slowest", {
                name: kind.slowest.scope ? `${kind.slowest.name} (${kind.slowest.scope})` : kind.slowest.name,
                took: took(kind.slowest.durationMs, t),
              })}
            </span>
          ) : null}
        </>
      )}
    </li>
  );
}

/** The run that made a check, linked where it is read, or the words for a check made by no run. */
function RunOf({ check, sessions, slug, t }: { check: IssueCheckRunView; sessions: IssueAgentSession[]; slug: string; t: Copy }) {
  if (!check.runSessionId) return <span className="text-12 text-subtle">{t("issues.checks.noRun")}</span>;
  const session = sessions.find((s) => s.id === check.runSessionId);
  const href = session?.pipelineRunId ? runHref(slug, session.pipelineRunId) : `${agentsListHref(slug)}/${encodeURIComponent(check.runSessionId)}`;
  return (
    <Link href={href} className="min-w-0 truncate text-12 text-link hover:underline">
      {session?.title ?? t("issues.checks.run", { id: check.runSessionId.slice(0, 8) })}
    </Link>
  );
}

/**
 * The time an issue's runs spent on checks (REQ-36 BC-14): each kind with its total, its count and
 * its slowest check, every kind listed, then each check with its result, duration and run.
 */
export function CheckTimes({ issueId, slug, sessions }: { issueId: string; slug: string; sessions: IssueAgentSession[] }) {
  const t = useCopy();
  const time = useTimeFormat();
  const q = useIssueChecks(issueId);
  if (q.isLoading) return <EmptyPanelLine title={t("issues.checks.title")} status={t("issues.steps.loading")} />;
  if (q.isError) return <EmptyPanelLine title={t("issues.checks.title")} status={t("common.couldNotLoad")} detail={formatApiError(q.error)} />;
  const view = q.data;
  if (!view) return null;
  return (
    <section aria-label={t("issues.checks.title")} data-testid="issue-checks">
      <ViewHeading right={view.checks.length ? <span className="text-12 text-muted tabular-nums">{t("issues.checks.total", { took: took(view.totalMs, t) })}</span> : undefined}>
        {t("issues.checks.title")}
      </ViewHeading>
      <ul className="divide-y divide-line-subtle border-y border-line-subtle">
        {view.kinds.map((kind) => (
          <KindRow key={kind.kind} kind={kind} t={t} />
        ))}
      </ul>
      {view.checks.length === 0 ? (
        <p className="mt-2 text-12 text-subtle">{t("issues.checks.noneHint")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line-subtle" aria-label={t("issues.checks.each")}>
          {view.checks.map((c) => (
            <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-13" data-testid="check-run">
              <span className="w-24 flex-none text-12 text-muted">{kindLabel(c.kind, t)}</span>
              <span className="min-w-0 flex-1 truncate" title={c.command || undefined}>
                {c.scope ? `${c.name} (${c.scope})` : c.name}
              </span>
              <span className={c.result === "fail" ? "text-12 text-danger" : "text-12 text-muted"}>{t(`issues.checks.result.${c.result}` as ProductCopyKey)}</span>
              <span className="tabular-nums">{took(c.durationMs, t)}</span>
              <RunOf check={c} sessions={sessions} slug={slug} t={t} />
              <span className="text-12 text-subtle" title={time.dateTime(c.startedAt)}>
                {time.relative(c.startedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
