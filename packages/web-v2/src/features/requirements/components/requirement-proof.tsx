"use client";

// The full page's views below the facts: the criteria with their verdicts and evidence, the
// revisions and the diff a proposal carries, and the history by source.

import { ISSUE_STATUS_LABELS, type KernelIssueStatus } from "@forge/contracts/issue-vocabulary";
import type { CoverageIssue, HistorySource, RequirementHistoryEntry } from "@forge/contracts/requirements";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { ActorChip, AGENT_TINT, LEGEND, SegmentedControl, StatusBadge, WhoMark } from "@/design";
import { formatRelativeTime, formatStamp as stamp } from "@/lib/utils/format";
import type { SuggestionView as Suggestion } from "@/features/suggestions/types";
import type { RequirementCriterion, RequirementDetail, RequirementRevision } from "../types";
import { issueHref } from "@/features/issues/routes";
import { diffColours } from "./standing-bits";

const issueWord = (s: string) => ISSUE_STATUS_LABELS[s as KernelIssueStatus] ?? s;

/** A heading inside a view: primary colour, 15/600, so it can never be mistaken for a label. */
export function ViewHeading({ children, right, id }: { children: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 id={id} className="text-15 font-semibold leading-snug text-fg">
        {children}
      </h2>
      {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
    </div>
  );
}

/** A label above a group of values: secondary, but readable (WCAG AA on every ground it sits on). */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <h3 className="mb-1.5 text-12-5 font-medium text-muted">{children}</h3>;
}

const Ins = ({ children }: { children: ReactNode }) => (
  <ins className="rounded-[3px] px-[3px] no-underline" style={{ background: diffColours.ins.bg, color: diffColours.ins.fg }}>
    {children}
  </ins>
);
const Del = ({ children }: { children: ReactNode }) => (
  <del className="rounded-[3px] px-[3px]" style={{ background: diffColours.del.bg, color: diffColours.del.fg }}>
    {children}
  </del>
);

function listDiff(label: string, before: string[] = [], after: string[] = []) {
  const kept = after.filter((x) => before.includes(x));
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  if (added.length === 0 && removed.length === 0) return null;
  return (
    <div key={label}>
      <h4 className="mb-1 mt-3 text-12-5 font-medium text-muted">{label}</h4>
      <ul className="grid list-disc gap-0.5 pl-[18px] text-14">
        {kept.map((x) => (
          <li key={`k-${x}`}>{x}</li>
        ))}
        {added.map((x) => (
          <li key={`a-${x}`}>
            <Ins>{x}</Ins>
          </li>
        ))}
        {removed.map((x) => (
          <li key={`r-${x}`}>
            <Del>{x}</Del>
          </li>
        ))}
      </ul>
    </div>
  );
}

function criteriaDiff(before: RequirementCriterion[], after: RequirementCriterion[]) {
  const rows: ReactNode[] = [];
  const codes = [...new Set([...before.map((c) => c.code), ...after.map((c) => c.code)])].sort(
    (a, b) => Number(a.slice(3)) - Number(b.slice(3)),
  );
  for (const code of codes) {
    const was = before.find((c) => c.code === code);
    const now = after.find((c) => c.code === code);
    if (was && now && was.body === now.body) continue;
    rows.push(
      <div key={code} className="grid grid-cols-[48px_minmax(0,1fr)] gap-2.5 border-b border-line-subtle py-2 text-14 last:border-0">
        <span className="font-mono text-11-5 font-semibold text-muted">{code}</span>
        <span className="grid gap-1">
          {was ? <Del>{was.body}</Del> : null}
          {now ? <Ins>{now.body}</Ins> : null}
        </span>
      </div>,
    );
  }
  if (rows.length === 0) return null;
  return (
    <div key="criteria">
      <h4 className="mb-1 mt-3 text-12-5 font-medium text-muted">Business criteria</h4>
      {rows}
    </div>
  );
}

/** What the open revision changes against the one it was written on: added green, removed struck. */
export function RevisionDiff({ base, next }: { base: RequirementRevision | undefined; next: RequirementRevision }) {
  const a = base?.spec ?? {};
  const b = next.spec;
  const parts = [
    a.goal !== b.goal ? (
      <div key="goal">
        <h4 className="mb-1 mt-3 text-12-5 font-medium text-muted">Goal and problem</h4>
        <p className="grid gap-1 text-14">
          {a.goal ? <Del>{a.goal}</Del> : null}
          {b.goal ? <Ins>{b.goal}</Ins> : null}
        </p>
      </div>
    ) : null,
    listDiff("Persona", a.personas, b.personas),
    listDiff("In scope", a.scopeIn, b.scopeIn),
    listDiff("Out of scope", a.scopeOut, b.scopeOut),
    criteriaDiff(base?.criteria ?? [], next.criteria),
  ].filter(Boolean);
  if (parts.length === 0) return <p className="text-12-5 text-subtle">The wording is unchanged; only the reason differs.</p>;
  return <div data-testid="revision-diff">{parts}</div>;
}

const VERDICT_WORD: Record<NonNullable<CoverageIssue["verdict"]>, string> = {
  pass: "Pass",
  short: "Short",
  fail: "Fail",
  skipped: "Skipped",
};

/** One line per issue, however many of its criteria trace here, with each criterion's evidence. */
function byIssue(links: CoverageIssue[]) {
  const seen = new Map<string, CoverageIssue[]>();
  for (const l of links) seen.set(l.issueId, [...(seen.get(l.issueId) ?? []), l]);
  return [...seen.values()].map((ls) => ({ i: ls[0] as CoverageIssue, links: ls, stale: ls.every((l) => l.stale) }));
}

/** Each business criterion once: its wording, its verdict, the issues tracing to it inline, and the
 *  per-criterion evidence behind an expander. */
export function CriteriaTable({ d, slug }: { d: RequirementDetail; slug: string }) {
  const cov = d.standing.coverage;
  if (cov.length === 0) return <p className="py-1.5 text-13 text-subtle">No criteria yet. Readiness needs at least one testable criterion.</p>;
  const shown = d.standing.shownRevision;
  const wording = new Map(d.criteria.map((c) => [c.code, c]));
  return (
    <ul className="border-t border-line-subtle" data-testid="criteria-table">
      {cov.map((c) => {
        const crit = wording.get(c.code);
        const issues = byIssue(c.issues);
        return (
          <li key={c.code} className="grid grid-cols-[52px_minmax(0,1fr)_auto] gap-x-3 border-b border-line-subtle py-3" data-testid="criterion-row">
            <span className="pt-0.5 font-mono text-12 font-semibold text-muted" title={crit ? `Since r${crit.sinceRevision}` : undefined}>
              {c.code}
            </span>
            <div className="min-w-0">
              {crit?.form === "scenario" ? (
                <pre className="whitespace-pre-wrap font-mono text-12-5 leading-relaxed">{c.body}</pre>
              ) : (
                <p className="text-14 leading-relaxed">{c.body}</p>
              )}
              {crit && shown !== null && crit.sinceRevision === shown && shown > 1 ? (
                <span className="mt-1 inline-block text-12 text-muted">Changed in r{shown}</span>
              ) : null}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-12-5">
                {issues.length === 0 ? (
                  <span className="text-subtle">{d.standing.facts.issuesTotal === 0 ? "Not broken down into issues yet" : "No issue traces here yet"}</span>
                ) : (
                  issues.map(({ i, stale }) => (
                    <span key={i.issueId} className="inline-flex min-w-0 items-center gap-1.5">
                      <Link href={issueHref(slug, i.displayId)} className="font-mono text-12 font-semibold text-link hover:underline">
                        {i.displayId}
                      </Link>
                      <span className="max-w-[36ch] truncate text-muted" title={i.title}>
                        {i.title}
                      </span>
                      <StatusBadge family="issue" value={i.status} />
                      {stale ? <span className="text-subtle">Earlier wording</span> : null}
                    </span>
                  ))
                )}
              </div>
              {c.issues.length > 0 ? (
                <details className="mt-1.5 text-12-5" data-testid="criterion-evidence">
                  <summary className="cursor-pointer select-none font-medium text-muted hover:text-fg">Evidence · {c.issues.length}</summary>
                  <ul className="mt-1 grid gap-0.5 pl-3">
                    {issues.flatMap(({ i, links }) =>
                      links.map((l) => (
                        <li key={`${i.issueId}-${l.criterion}`} className="text-muted">
                          <span className="font-mono text-12">{i.displayId}</span> criterion {l.criterion} ·{" "}
                          {l.verdict ? `latest verdict ${VERDICT_WORD[l.verdict]}` : "no verdict yet"}
                          {l.stale ? " · traces to an earlier wording" : ""}
                        </li>
                      )),
                    )}
                  </ul>
                </details>
              ) : null}
            </div>
            <div className="pt-0.5">
              <StatusBadge family="bcVerdict" value={c.verdict} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type Check = { check?: unknown; passed?: unknown; detail?: unknown };

/** The newest readiness check the BA assistant proposed, as one line: met of total, one mark per check. */
export function Readiness({ suggestions }: { suggestions: Suggestion[] }) {
  const r = suggestions.find((s) => s.kind === "readiness");
  const raw = (r?.payload as { checks?: unknown } | null | undefined)?.checks;
  const checks = (Array.isArray(raw) ? raw : []) as Check[];
  if (!r || checks.length === 0) return <span className="text-muted">Readiness not checked yet</span>;
  const met = checks.filter((c) => c.passed === true).length;
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="readiness">
      <span title={checks.map((c) => `${c.passed === true ? "Met" : "Not met"} · ${String(c.check ?? "")}`).join("\n")}>
        Readiness <b className="font-semibold text-fg">{met} of {checks.length}</b> met
      </span>
      <span className="inline-flex gap-0.5">
        {checks.map((c) => (
          <span
            key={`${String(c.check)}-${String(c.detail)}`}
            title={`${String(c.check ?? "")}${typeof c.detail === "string" ? ` — ${c.detail}` : ""}`}
            className="block h-2.5 w-4 rounded-[2px]"
            style={{ background: c.passed === true ? LEGEND.ready.dot : LEGEND.you.dot }}
          />
        ))}
      </span>
      {r.baseRevision !== null ? <span className="text-subtle">on r{r.baseRevision}</span> : null}
    </span>
  );
}

/** Every revision newest first, as rows: number, state, author, what it changed, when. */
export function RevisionList({ d }: { d: RequirementDetail }) {
  if (d.revisions.length === 0) return <p className="text-13 text-subtle">No revision yet.</p>;
  const agreed = new Map(d.baselines.map((b) => [b.revision, b]));
  return (
    <ul className="border-t border-line-subtle" data-testid="revision-list">
      {d.revisions.map((r) => {
        const signed = agreed.get(r.revision);
        const at = r.decidedAt ?? r.proposedAt ?? r.createdAt;
        return (
          <li key={r.revision} className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-line-subtle py-2.5 text-13">
            <span className="pt-0.5 font-mono text-12 font-semibold text-fg">r{r.revision}</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge family="revision" value={r.state} />
                {signed ? (
                  <span className="text-12 text-muted" title={`Agreed ${stamp(signed.agreedAt)}${signed.agreedByName ? ` by ${signed.agreedByName}` : ""}`}>
                    Agreed
                  </span>
                ) : null}
                <span className="text-12 text-muted">
                  <ActorChip name={r.authorName ?? "Its author"} kind={r.authorKind} size={16} />
                </span>
              </div>
              <p className="mt-1 text-13-5">{r.changeSummary ?? r.reason}</p>
              {r.returnReason ? <p className="mt-0.5 text-12-5 text-muted">Returned: {r.returnReason}</p> : null}
            </div>
            <span className="whitespace-nowrap pt-0.5 text-12 text-subtle" title={stamp(at)}>
              {formatRelativeTime(at)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const SOURCES: { value: "all" | HistorySource; label: string }[] = [
  { value: "all", label: "All" },
  { value: "person", label: "People" },
  { value: "agent", label: "Agents" },
  { value: "system", label: "System" },
];

function entryText(e: RequirementHistoryEntry): ReactNode {
  if (e.move) {
    return (
      <>
        <span className="font-mono text-12">{e.issue}</span> · {e.move.from ? `${issueWord(e.move.from)} → ` : ""}
        {issueWord(e.move.to)}
      </>
    );
  }
  return (
    <>
      {e.issue ? <span className="mr-1 font-mono text-12 text-subtle">{e.issue}</span> : null}
      {e.text}
    </>
  );
}

/** Who did what, newest first, filtered by source. */
export function History({ entries }: { entries: RequirementHistoryEntry[] }) {
  const [source, setSource] = useState<"all" | HistorySource>("all");
  const count = (s: "all" | HistorySource) => (s === "all" ? entries.length : entries.filter((e) => e.source === s).length);
  const options = SOURCES.filter((o) => count(o.value) > 0).map((o) => ({ ...o, count: count(o.value) }));
  const shown = entries.filter((e) => source === "all" || e.source === source);
  if (entries.length === 0) return <p className="py-1.5 text-13 text-subtle">Nothing recorded yet.</p>;
  return (
    <div data-testid="requirement-history">
      <div className="mb-3">
        <SegmentedControl options={options} value={source} onChange={setSource} />
      </div>
      <ul>
        {shown.map((e) => {
          const question = e.kind === "Question" && e.source === "agent";
          return (
            <li
              key={e.id}
              className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 border-b border-line-subtle py-2.5 text-14 last:border-0"
              style={question ? { background: AGENT_TINT.bg, borderLeft: `3px solid ${AGENT_TINT.dot}`, paddingLeft: 6 } : undefined}
            >
              <span className="pt-px">
                <WhoMark kind={e.source} who={e.who} size={18} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-12 text-subtle">
                  <b className="text-13 font-semibold text-fg">{e.who}</b>
                  <span className="text-12 font-medium text-muted">{e.kind}</span>
                  <span title={stamp(e.at)}>{formatRelativeTime(e.at)}</span>
                </div>
                <div className="mt-0.5 break-words">{entryText(e)}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
