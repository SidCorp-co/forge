
// ISS-55 — the issue's acceptance criteria as one line each: its number, the statement clipped to the
// line, and a mark for the verdict (REQ-43 BC-10). The filter pills carry the counts, so no row does.
// A person's view reads each statement without the trace code an agent wrote at its head, and each
// verdict without the commit it was taken at; the developer view reads both (BC-7).
// A row opens on its full statement, the verdict's identity, reason and evidence, and, for a person
// who may write, the act that records a verdict. The criteria a reword or a re-tie retired are
// Activity's, each marked Retired with every verdict it earned, so an earlier judge's finding stays
// readable (ISS-489).

import { type ReactNode, useState } from "react";
import { EmptyPanelLine, StatusBadge, statusReading, VerdictEvidence, ViewHeading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { CriterionStanding } from "@forge/contracts/issue-vocabulary";
import { criterionStandingOf } from "@forge/contracts/verdict-identity";
import { cn } from "@/lib/utils/cn";
import { withoutCriterionCode } from "@/lib/utils/criterion-code";
import { identityPhrase } from "../identity-phrase";
import { type CriterionRow, type CriterionVerdict, type RetiredCriterionRow, useCriteria } from "../criteria";
import { clipWords } from "../derive";
import { useAttachments } from "../detail-hooks";
import { RecordVerdict } from "./criteria-acts";

function tooltipOf(row: CriterionRow, t: Copy, language: string, at: (iso: string) => string, developer: boolean): string {
  const v = row.latest;
  if (!v) return t("issues.verdict.none");
  return verdictLines(v, t, language, at, developer);
}

function verdictLines(v: CriterionVerdict, t: Copy, language: string, at: (iso: string) => string, developer = true): string {
  const by = v.authorAgency === "agent" ? t("issues.verdict.byAgent") : t("issues.verdict.byPerson");
  const word = v.verdict === "short" ? t("issues.verdict.short") : statusReading("criterion", v.verdict, language).label;
  const parts = [
    developer ? `${word} · ${identityPhrase(v, t)}` : word,
    v.reason ? t("issues.verdict.reason", { reason: v.reason }) : null,
    t("issues.verdict.by", { by, at: at(v.createdAt) }),
  ];
  return parts.filter(Boolean).join("\n");
}

/** Words of a criterion's statement a row shows; the rest is on the open row (REQ-43: a row is at most 12 words). */
const ROW_WORDS = 8;

type Filter = "all" | "fail" | "unjudged" | "pass" | "skipped";

const MARK: Record<CriterionStanding, string> = { pass: "✓", short: "✓", fail: "✕", skipped: "↷", unresolved: "–", unjudged: "–" };
const MARK_TONE: Record<CriterionStanding, string> = {
  pass: "text-ok-11",
  short: "text-ok-11",
  fail: "text-danger",
  skipped: "text-subtle",
  unresolved: "text-subtle",
  unjudged: "text-subtle",
};

/** The pill a standing is counted under: Short counts as a pass, and an unresolved commit as not judged. */
const FILTER_OF: Record<CriterionStanding, Exclude<Filter, "all">> = {
  pass: "pass",
  short: "pass",
  fail: "fail",
  skipped: "skipped",
  unresolved: "unjudged",
  unjudged: "unjudged",
};

/** One criterion a reader sees, from a criterion row or from a line of the acceptance-criteria text. */
interface CriterionLine {
  id: string;
  n: number;
  statement: string;
  standing: CriterionStanding;
  row: CriterionRow | null;
}

function Pill({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-pill border px-2.5 py-0.5 text-13 focus-visible:outline-none focus-visible:shadow-focus",
        pressed ? "border-fg text-fg" : "border-line-subtle text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function CriterionItem({
  line,
  issueId,
  judge,
  kept,
  developer,
}: {
  line: CriterionLine;
  issueId: string;
  judge: boolean | undefined;
  kept: ReturnType<typeof useAttachments>["data"];
  developer: boolean;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const [open, setOpen] = useState(false);
  const reading = statusReading("criterion", line.standing, language).label;
  const row = line.row;
  const statement = developer ? line.statement : withoutCriterionCode(line.statement);
  return (
    <li className="border-t border-line-subtle first:border-t-0" data-testid="criterion-row">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-baseline gap-3 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-focus"
      >
        <span className="w-8 flex-none tabular-nums text-subtle">{line.n}</span>
        <span className="min-w-0 flex-1 truncate">{clipWords(statement, ROW_WORDS)}</span>
        <span className={cn("w-6 flex-none text-center font-semibold", MARK_TONE[line.standing])} role="img" aria-label={reading} title={reading} data-testid={`criterion-${line.n}-verdict`}>
          {MARK[line.standing]}
        </span>
      </button>
      {open ? (
        <div className="grid gap-2 pb-3 pl-11 text-13 text-muted" data-testid="criterion-full">
          <p className="whitespace-pre-wrap">{statement}</p>
          {row ? (
            <>
              <p className="whitespace-pre-wrap">{tooltipOf(row, t, language, time.dateTime, developer)}</p>
              <VerdictEvidence
                className="grid gap-1 text-13"
                note={row.latest?.reason?.trim() ? row.latest.reason : null}
                files={(row.latest?.evidence ?? []).flatMap((name) => {
                  const file = (kept ?? []).find((a) => a.name === name);
                  return file ? [{ name: file.name, mime: file.mime, url: file.url }] : [];
                })}
              />
              {judge ? (
                <div>
                  <RecordVerdict issueId={issueId} row={row} />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Criterion rows, or the lines of the acceptance-criteria text where the issue has no rows yet. */
export function CriteriaList({
  issueId,
  judge,
  headingAct,
  checklist = [],
  developer = false,
}: {
  issueId: string;
  /** The developer view: each statement with its trace code, each verdict with its commit. */
  developer?: boolean;
  /** Whether the reader may record a verdict; the Judge reads the build it defaults to from core. */
  judge?: boolean;
  headingAct?: ReactNode;
  checklist?: { key: string; text: string; checked: boolean }[];
}) {
  const q = useCriteria(issueId);
  const kept = useAttachments(issueId);
  const t = useCopy();
  const [filter, setFilter] = useState<Filter>("all");
  if (q.isLoading) return <EmptyPanelLine title={t("issues.tab.criteria")} status={t("issues.steps.loading")} />;
  if (q.isError) {
    return <EmptyPanelLine title={t("issues.tab.criteria")} status={t("common.couldNotLoad")} detail={formatApiError(q.error)} />;
  }
  const rows = q.data?.criteria ?? [];
  const lines: CriterionLine[] =
    rows.length > 0
      ? rows.map((row) => ({ id: row.id, n: row.n, statement: row.statement, standing: criterionStandingOf(row.latest), row }))
      : checklist.map((item, i) => ({ id: item.key, n: i + 1, statement: item.text, standing: item.checked ? "pass" : "unjudged", row: null }));
  const count = (f: Filter) => (f === "all" ? lines.length : lines.filter((l) => FILTER_OF[l.standing] === f).length);
  const pills: { value: Filter; label: string }[] = [
    { value: "all", label: t("issues.criteria.pill.all", { n: count("all") }) },
    { value: "fail", label: t("issues.criteria.pill.fail", { n: count("fail") }) },
    { value: "unjudged", label: t("issues.criteria.pill.unjudged", { n: count("unjudged") }) },
    { value: "pass", label: t("issues.criteria.pill.pass", { n: count("pass") }) },
    { value: "skipped", label: t("issues.criteria.pill.skipped", { n: count("skipped") }) },
  ];
  const shown = lines.filter((l) => filter === "all" || FILTER_OF[l.standing] === filter);
  return (
    <section aria-label={t("issues.tab.criteria")} data-testid="view-criteria" data-highlight="criteria">
      <ViewHeading right={headingAct}>{t("issues.tab.criteria")}</ViewHeading>
      {lines.length === 0 ? (
        <p className="text-13 text-subtle">{t("issues.criteria.empty")}</p>
      ) : (
        <>
          <fieldset className="m-0 mb-2 flex min-w-0 flex-wrap gap-1.5 border-0 p-0" aria-label={t("issues.criteria.show")}>
            {pills
              .filter((p) => p.value === "all" || count(p.value) > 0)
              .map((p) => (
                <Pill key={p.value} pressed={filter === p.value} onClick={() => setFilter(p.value)}>
                  {p.label}
                </Pill>
              ))}
          </fieldset>
          <ol className="text-14">
            {shown.map((line) => (
              <CriterionItem key={line.id} line={line} issueId={issueId} judge={judge} kept={kept.data} developer={developer} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/** The issue's retired criteria, for Activity: nothing at all while it has none. */
export function IssueRetiredCriteria({ issueId }: { issueId: string }) {
  const q = useCriteria(issueId);
  if (q.isLoading || q.isError) return null;
  return <RetiredCriteria rows={q.data?.retired ?? []} />;
}

/** The retired criteria, collapsed: each marked Retired, with when, and every verdict it earned. */
function RetiredCriteria({ rows }: { rows: RetiredCriterionRow[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  if (rows.length === 0) return null;
  return (
    <details className="mt-3 text-13" data-testid="retired-criteria">
      <summary className="cursor-pointer select-none font-medium text-muted hover:text-fg">
        {t("issues.criteria.retired", { n: rows.length })}
      </summary>
      <ol className="mt-1 divide-y divide-line-subtle">
        {rows.map((row) => (
          <li key={row.id} className="py-2" data-testid="retired-criterion">
            <div className="flex items-start gap-3">
              <span className="w-6 shrink-0 tabular-nums text-muted">
                {row.n}.
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted">{row.statement}</span>
              <span className="shrink-0 text-12 font-semibold text-muted" title={time.dateTime(row.retiredAt)} data-testid="retired-mark">
                {t("issues.criteria.retiredMark", { at: time.relative(row.retiredAt) })}
              </span>
            </div>
            {row.verdicts.length === 0 ? (
              <p className="mt-1 pl-9 text-13 text-subtle">{t("issues.verdict.none")}</p>
            ) : (
              <ul className="mt-1 grid gap-1 pl-9">
                {row.verdicts.map((v) => (
                  <li key={`${row.id}-${v.createdAt}`} className="flex items-start gap-2 text-13" data-testid="retired-verdict">
                    <StatusBadge family="criterion" value={criterionStandingOf(v)} />
                    <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted">{verdictLines(v, t, language, time.dateTime)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
