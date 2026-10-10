"use client";

import Link from "next/link";
import type { CheckKindTime, IssueCheckRunView } from "@forge/contracts/check-runs";
import { EmptyPanelLine, ViewHeading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { agentsListHref, runHref } from "@/lib/routes/agents";
import { useIssueChecks } from "../../checks-api";
import type { IssueAgentSession } from "../../types";
import { formatDuration } from "@/lib/i18n/format";

const kindLabel = (kind: string, t: Copy) => t(`issues.checks.kind.${kind}` as ProductCopyKey);

/** One kind of check: how many ran, the time they took together, and the slowest. */
function CheckKind({ kind, t }: { kind: CheckKindTime; t: Copy }) {
  const language = useInterfaceLanguage();
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-13" data-testid="check-kind" data-kind={kind.kind}>
      <span className="w-40 flex-none fg-label">{kindLabel(kind.kind, t)}</span>
      {kind.checks === 0 ? (
        <span className="text-subtle">{t("issues.checks.noneOfKind")}</span>
      ) : (
        <>
          <span className="tabular-nums">{formatDuration(kind.totalMs, language)}</span>
          <span className="text-12 text-muted">{kind.checks === 1 ? t("issues.checks.count.one") : t("issues.checks.count.many", { n: kind.checks })}</span>
          {kind.slowest ? (
            <span className="min-w-0 break-words text-12 text-muted">
              {t("issues.checks.slowest", {
                name: kind.slowest.scope ? `${kind.slowest.name} (${kind.slowest.scope})` : kind.slowest.name,
                took: formatDuration(kind.slowest.durationMs, language),
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
  if (!check.runSessionId) return <span className="text-subtle">{t("issues.checks.noRun")}</span>;
  const session = sessions.find((s) => s.id === check.runSessionId);
  const href = session?.pipelineRunId ? runHref(slug, session.pipelineRunId) : `${agentsListHref(slug)}/${encodeURIComponent(check.runSessionId)}`;
  return (
    <Link href={href} className="min-w-0 break-words text-link hover:underline">
      {session?.title ?? t("issues.checks.run", { id: check.runSessionId.slice(0, 8) })}
    </Link>
  );
}

/**
 * One check, on as many lines as its words need: its name and scope with its result and duration,
 * then its kind, run, time and commit, then its note. The name wraps and is never cut short — on
 * one line beside six columns it shrank to 1-3 characters at phone width, Failed row included.
 */
function CheckTime({ check: c, sessions, slug, t }: { check: IssueCheckRunView; sessions: IssueAgentSession[]; slug: string; t: Copy }) {
  const time = useTimeFormat();
  return (
    <li className="py-2 text-13" data-testid="check-run">
      <div className="flex items-baseline gap-x-3">
        <span className="min-w-0 flex-1 break-words" title={c.command || undefined}>
          {c.scope ? `${c.name} (${c.scope})` : c.name}
        </span>
        <span className={c.result === "fail" ? "flex-none text-12 text-danger" : "flex-none text-12 text-muted"}>{t(`issues.checks.result.${c.result}` as ProductCopyKey)}</span>
        <span className="flex-none tabular-nums">{time.duration(c.durationMs)}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-12 text-muted">
        <span>{kindLabel(c.kind, t)}</span>
        <RunOf check={c} sessions={sessions} slug={slug} t={t} />
        <span className="text-subtle" title={time.dateTime(c.startedAt)}>
          {time.relative(c.startedAt)}
        </span>
        <span className="font-mono text-subtle" title={t("issues.checks.head", { sha: c.head })}>
          {c.head.slice(0, 7)}
        </span>
      </div>
      {c.note ? <p className="mt-0.5 break-words text-12 text-subtle">{c.note}</p> : null}
    </li>
  );
}

/**
 * The time an issue's runs spent on checks (REQ-36 BC-14): each kind with its total, its count and
 * its slowest check, every kind listed, then each check with its result, duration and run.
 */
export function CheckTimes({ issueId, slug, sessions }: { issueId: string; slug: string; sessions: IssueAgentSession[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const q = useIssueChecks(issueId);
  if (q.isLoading) return <EmptyPanelLine title={t("issues.checks.title")} status={t("issues.steps.loading")} />;
  if (q.isError) return <EmptyPanelLine title={t("issues.checks.title")} status={t("common.couldNotLoad")} detail={formatApiError(q.error)} />;
  const view = q.data;
  if (!view) return null;
  return (
    <section aria-label={t("issues.checks.title")} data-testid="issue-checks">
      <ViewHeading right={view.checks.length ? <span className="text-12 text-muted tabular-nums">{t("issues.checks.total", { took: formatDuration(view.totalMs, language) })}</span> : undefined}>
        {t("issues.checks.title")}
      </ViewHeading>
      <ul className="divide-y divide-line-subtle border-y border-line-subtle">
        {view.kinds.map((kind) => (
          <CheckKind key={kind.kind} kind={kind} t={t} />
        ))}
      </ul>
      {view.checks.length === 0 ? (
        <p className="mt-2 text-12 text-subtle">{t("issues.checks.none")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line-subtle" aria-label={t("issues.checks.each")}>
          {view.checks.map((c) => (
            <CheckTime key={c.id} check={c} sessions={sessions} slug={slug} t={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
