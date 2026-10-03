"use client";

// The full page's evidence: the revision diff a proposal carries, the proof chain (business
// criterion → issues → verdict) and readiness, the relations rail, and the history by source.

import { ISSUE_STATUS_LABELS, ISSUE_STATUS_TONES, type KernelIssueStatus } from "@forge/contracts/issue-vocabulary";
import type { CoverageIssue, HistorySource, RequirementHistoryEntry } from "@forge/contracts/requirement-standing";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { SegmentedControl, StatusChip } from "@/design";
import { issueStatusChip } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import { workflowHref } from "@/features/workflows/routes";
import { formatRelativeTime } from "@/lib/utils/format";
import type { RequirementCriterion, RequirementDetail, RequirementRevision, Suggestion } from "../types";
import { DesignStatusBadge } from "./badges";
import { VerdictBadge, WhoMark, stamp } from "./standing-bits";
import { TONE } from "./tone";

const issueHref = (slug: string, key: string) => `/projects/${encodeURIComponent(slug)}/issues/${encodeURIComponent(key)}`;
const issueWord = (s: string) => ISSUE_STATUS_LABELS[s as KernelIssueStatus] ?? s;
const issueDot = (s: string) => TONE[ISSUE_STATUS_TONES[s as KernelIssueStatus] ?? "neutral"].dot;

export function IssueChip({ status }: { status: string }) {
  const c = issueStatusChip(status as IssueStatus);
  return <StatusChip status={c.status} label={c.label} glyph={c.glyph} title={c.title} size="sm" />;
}

export function SubHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1.5 mt-4 flex flex-wrap items-center gap-2 text-13 font-bold first:mt-1">
      {children}
      {right ? <span className="ml-auto text-12 font-medium text-subtle">{right}</span> : null}
    </div>
  );
}

const Ins = ({ children }: { children: ReactNode }) => (
  <ins className="rounded-[3px] px-[3px] no-underline" style={{ background: TONE.ready.bg, color: TONE.ready.fg }}>
    {children}
  </ins>
);
const Del = ({ children }: { children: ReactNode }) => (
  <del className="rounded-[3px] px-[3px]" style={{ background: TONE.err.bg, color: TONE.err.fg }}>
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
      <h5 className="mb-1 mt-3 text-12-5 font-bold text-muted">{label}</h5>
      <ul className="grid list-disc gap-0.5 pl-[18px] text-13-5">
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
      <div key={code} className="grid grid-cols-[44px_minmax(0,1fr)] gap-2.5 border-b border-line-subtle py-2 text-13 last:border-0">
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
      <h5 className="mb-1 mt-3 text-12-5 font-bold text-muted">Business criteria</h5>
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
        <h5 className="mb-1 mt-3 text-12-5 font-bold text-muted">Goal and problem</h5>
        <p className="grid gap-1 text-13-5">
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

/** One line per issue, however many of its criteria trace here; each criterion's verdict on hover. */
function byIssue(links: CoverageIssue[]) {
  const seen = new Map<string, CoverageIssue[]>();
  for (const l of links) seen.set(l.issueId, [...(seen.get(l.issueId) ?? []), l]);
  return [...seen.values()].map((ls) => ({
    i: ls[0] as CoverageIssue,
    stale: ls.every((l) => l.stale),
    tip: ls
      .map((l) => `Criterion ${l.criterion} · ${l.verdict ? `latest verdict ${l.verdict}` : "no verdict yet"}${l.stale ? " · traces to an earlier wording" : ""}`)
      .join("\n"),
  }));
}

/** Business criterion → the issues whose criteria trace to it → its verdict. */
export function ProofChain({ d, slug }: { d: RequirementDetail; slug: string }) {
  const cov = d.standing.coverage;
  if (cov.length === 0) return <p className="py-1.5 text-12-5 text-subtle">No criteria to trace yet.</p>;
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)_auto] gap-x-3 text-13" data-testid="proof-chain">
      {cov.map((c) => (
        <div key={c.code} className="contents">
          <div className="flex items-center border-b border-line-subtle py-2 font-mono text-11-5 font-bold text-muted">{c.code}</div>
          <div className="flex min-w-0 flex-col gap-[5px] border-b border-line-subtle py-2">
            <span>{c.body}</span>
            <span className="flex flex-col items-start gap-0.5">
              {c.issues.length === 0 ? (
                <span className="text-12 text-muted before:mr-1 before:text-[var(--paper-400)] before:content-['↳']">
                  {d.standing.facts.issuesTotal === 0 ? "Not broken down" : "No issue traces here yet"}
                </span>
              ) : (
                byIssue(c.issues).map(({ i, tip, stale }) => (
                  <span
                    key={i.issueId}
                    className="inline-flex min-w-0 items-center gap-[5px] text-12 text-muted before:text-[var(--paper-400)] before:content-['↳']"
                    title={tip}
                  >
                    <span aria-hidden className="size-2 flex-none rounded-full" style={{ background: issueDot(i.status) }} />
                    <Link href={issueHref(slug, i.displayId)} className="font-mono text-11-5 font-semibold text-link hover:underline">
                      {i.displayId}
                    </Link>
                    <span className="max-w-[44ch] truncate">{i.title}</span>
                    <span>· {issueWord(i.status)}</span>
                    {stale ? <span className="text-subtle">· earlier wording</span> : null}
                  </span>
                ))
              )}
            </span>
          </div>
          <div className="flex items-center justify-end border-b border-line-subtle py-2">
            <VerdictBadge verdict={c.verdict} />
          </div>
        </div>
      ))}
    </div>
  );
}

type Check = { check?: unknown; passed?: unknown; detail?: unknown };

/** The newest readiness check the BA assistant proposed, as met-of-total and one mark per check. */
export function Readiness({ suggestions }: { suggestions: Suggestion[] }) {
  const r = suggestions.find((s) => s.kind === "readiness");
  const checks = (Array.isArray(r?.payload?.checks) ? r?.payload?.checks : []) as Check[];
  if (!r || checks.length === 0) return <p className="py-1.5 text-12-5 text-subtle">No readiness check yet.</p>;
  const met = checks.filter((c) => c.passed === true).length;
  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5 text-12-5" data-testid="readiness">
      <span title={checks.map((c) => `${c.passed === true ? "Met" : "Not met"} · ${String(c.check ?? "")}`).join("\n")}>
        Met <b>{met} of {checks.length}</b>
      </span>
      <span className="inline-flex gap-0.5">
        {checks.map((c) => (
          <span
            key={`${String(c.check)}-${String(c.detail)}`}
            title={`${String(c.check ?? "")}${typeof c.detail === "string" ? ` — ${c.detail}` : ""}`}
            className="block h-2.5 w-4 rounded-[2px]"
            style={{ background: c.passed === true ? TONE.ready.dot : TONE.you.dot }}
          />
        ))}
      </span>
      {r.baseRevision !== null ? <span className="text-12 text-subtle">on r{r.baseRevision}</span> : null}
    </div>
  );
}

function H6({ children }: { children: ReactNode }) {
  return <h6 className="mb-1 mt-3.5 flex items-center gap-1.5 text-12 font-semibold text-subtle">{children}</h6>;
}

function Prop({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-2 py-[5px] text-12-5">
      <span className="text-12 text-subtle">{k}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** The rail: issues, designs, needs from other projects, then the requirement's properties. */
export function RelationsRail({ d, slug }: { d: RequirementDetail; slug: string }) {
  const f = d.standing.facts;
  const baseline = d.baselines[0];
  const needs = baseline?.pins.filter((p) => p.kind === "contract-version") ?? [];
  return (
    <>
      <H6>
        Issues {f.issuesDone} of {f.issuesTotal} done
      </H6>
      {d.issues.length === 0 ? (
        <p className="py-1.5 text-12-5 text-subtle">No issues yet.</p>
      ) : (
        d.issues.map((i) => (
          <div key={i.issueId} className="flex min-w-0 items-center gap-1.5 py-1 text-12-5" data-testid="rail-issue">
            <Link href={issueHref(slug, i.displayId)} className="font-mono text-11-5 font-semibold text-link hover:underline">
              {i.displayId}
            </Link>
            <span className="min-w-0 flex-1 truncate" title={i.changedSincePlan ? `${i.title} · planned on r${i.plannedRevision}; the requirement moved since` : i.title}>
              {i.title}
            </span>
            {i.changedSincePlan ? (
              <span role="img" aria-label="Changed since plan" title="Changed since plan" className="size-1.5 flex-none rounded-full" style={{ background: TONE.you.dot }} />
            ) : null}
            <IssueChip status={i.status} />
          </div>
        ))
      )}
      {d.workflows.length > 0 ? (
        <>
          <H6>Design</H6>
          {d.workflows.map((w) => (
            <div key={w.workflowId} className="flex min-w-0 items-center gap-1.5 py-1 text-12-5">
              <Link href={workflowHref(slug, w.flow)} className="min-w-0 flex-1 truncate text-link hover:underline">
                {w.title}
              </Link>
              {w.designStatus ? <DesignStatusBadge status={w.designStatus} /> : null}
            </div>
          ))}
        </>
      ) : null}
      {needs.length > 0 ? (
        <>
          <H6>Needs from other projects</H6>
          {needs.map((p) => (
            <div key={`${p.contractSlug}@${p.contractVersion}`} className="py-1 font-mono text-12" title="Pinned at the agree">
              {p.contractSlug} ≥ {p.contractVersion}
            </div>
          ))}
        </>
      ) : null}
      <H6>Properties</H6>
      <Prop k="Owner">{d.standing.owner?.name ?? <span className="text-subtle">None</span>}</Prop>
      <Prop k="Revision">
        {d.currentRevision !== null ? `Rev ${d.currentRevision}` : "None accepted"}
        {f.proposedRevision !== null ? ` · rev ${f.proposedRevision} proposed` : ""}
      </Prop>
      <Prop k="Agreed">
        {baseline ? (
          <span title={stamp(baseline.agreedAt)}>
            r{baseline.revision} · {baseline.agreedByName ?? "a signer"}
          </span>
        ) : (
          <span className="text-subtle">Not yet</span>
        )}
      </Prop>
      <Prop k="Created">
        <span title={stamp(d.createdAt)}>{formatRelativeTime(d.createdAt)}</span>
      </Prop>
    </>
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
  if (entries.length === 0) return <p className="py-1.5 text-12-5 text-subtle">Nothing recorded yet.</p>;
  return (
    <div data-testid="requirement-history">
      <div className="mb-2">
        <SegmentedControl options={options} value={source} onChange={setSource} />
      </div>
      <ul>
        {shown.map((e) => {
          const question = e.kind === "Question" && e.source === "agent";
          return (
            <li
              key={e.id}
              className="grid grid-cols-[20px_minmax(0,1fr)] gap-2 border-b border-line-subtle py-2 text-13 last:border-0"
              style={question ? { background: TONE.ai.bg, borderLeft: `3px solid ${TONE.ai.dot}`, paddingLeft: 6 } : undefined}
            >
              <span className="pt-px">
                <WhoMark kind={e.source} who={e.who} size={18} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-12 text-subtle">
                  <b className="text-12-5 font-semibold text-fg">{e.who}</b>
                  <span className="rounded-[4px] bg-sunken px-1.5 text-11-5 font-medium text-muted">{e.kind}</span>
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
