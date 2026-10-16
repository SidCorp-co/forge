"use client";

// The release half of Shape & release, read off the stored declaration: the one-line answer to
// "can this project release?" with every reason under it at the top of the page, and the details a
// release runs with (targets, runner label, rollback, probes) at its foot.

import type { ReleaseBlockerCode } from "@forge/contracts";
import { ISSUE_STATUS_LABELS, type KernelIssueStatus } from "@forge/contracts/issue-vocabulary";
import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorState, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useReleaseReadiness } from "../hooks";
import { releaseAnswer } from "../shape-form";
import type { ReleaseReadiness } from "../types";
import { inlineCode } from "./inline-code";
import { LIVE_DEPLOY_TARGET } from "./integrations-tab";

/** Each gap as the reader of this page says it: what is missing and what that costs, never the key it is stored under. */
export const GAP_TEXT: Record<ReleaseReadiness["gaps"][number], string> = {
  "build-commands": "No build commands written — an agent has nothing to build with.",
  "test-commands": "No test commands written — an agent has nothing to prove its work with.",
  "release-procedure":
    "No release instructions written — a release follows generic instructions written for another project.",
  "release-runner-ambiguous":
    "Live bindings name different release runners — a release is refused rather than sent to whichever was created first. Give them the same label, or retire all but one.",
  "release-target":
    "This project declares a release but has no live deploy target to send it to — every issue would wait for a release nobody can cut. Add one, or, if this project ships nothing, choose \"Repository, no release\" below.",
  rollback:
    "No rollback declared — a failed release aborts and comments, and rolls back nothing.",
  "rollback-prose":
    "A live Coolify binding declares its rollback as free text, which Forge no longer executes — convert it to the Coolify rollback action, or a failed release aborts and comments.",
  "verify-probes":
    "A live binding declares no verify probe — a release still runs, but nothing reads that deployment. Where no live binding declares one the release closes unverified; where another does, each issue it closes names this one as not read.",
  "live-commit-endpoint":
    "This project records no live commit endpoint — nothing holds the address a release ships to, so every live binding has to declare its own probe.",
};

const ROLLBACK_TEXT: Record<NonNullable<ReleaseReadiness["rollbackMode"]>, string> = {
  manual: "declared — the release agent follows it",
  "coolify-image": "Forge rolls back to a Coolify image",
  unrepresentable: "free text — not executed, abort and comment",
};

/** What a field says when the read behind it failed. Never its default, which
 *  would show an unreadable binding as a binding that declares nothing. */
const UNREAD = "could not be read";

const NO_RELEASE_RUNNER_LABEL = "none — a release goes to any box in this project's pool";

const FACT_GAPS = new Set(["build-commands", "test-commands", "release-procedure"]);

/** Where "add a live deploy target" lands: the section that adds one, with Deploy target and Live chosen. */
const ADD_LIVE_TARGET = { tab: "integrations", add: LIVE_DEPLOY_TARGET, label: "Add a live deploy target" };

/** The gap that restates a blocker, where a readiness answer carries both. */
const BLOCKER_GAP: Record<string, ReleaseReadiness["gaps"][number]> = {
  RELEASE_TARGET_UNDECLARED: "release-target",
  RELEASE_RUNNER_AMBIGUOUS: "release-runner-ambiguous",
};

type Blocker = ReleaseReadiness["blockers"][number];

/** Where the link beside a blocker goes: the setting that answers it, the issues at the statuses its
 *  sentence counts, the particular issues it names, or nowhere, where its sentence names no issue. */
type BlockerLink =
  | { kind: "setting"; tab: string; add?: string; label: string }
  | { kind: "statuses"; statuses: KernelIssueStatus[]; label: string }
  | { kind: "issues"; displayIds: string[] }
  | null;

const setting = (tab: string, label: string, add?: string) => (): BlockerLink => ({
  kind: "setting",
  tab,
  label,
  ...(add ? { add } : {}),
});

/** How many of something the sentence counts, where its details carry them as a list or a number;
 *  null where they carry neither, and the sentence then speaks of them in the plural. */
function countOf(v: unknown): number | null {
  if (Array.isArray(v)) return v.length;
  return typeof v === "number" ? v : null;
}

/** The singular where the sentence counts exactly one, so a link refers back to what it names. */
const one = (n: number | null, single: string, many: string) => (n === 1 ? single : many);

/** The issues at Awaiting release, counted by whichever detail the sentence counts them by. */
const AT_AWAITING_RELEASE =
  (key: string) =>
  (b: Blocker): BlockerLink => ({
    kind: "statuses",
    statuses: ["awaiting_release"],
    label: `Open ${one(countOf(b.details?.[key]), "the issue", "the issues")} at ${ISSUE_STATUS_LABELS.awaiting_release}`,
  });

/** A refused `verify` names its bindings; a probe url no request could reach names only the url. */
function probesLink(b: Blocker): BlockerLink {
  const bindings = countOf(b.details?.bindings) ?? 0;
  const urls = countOf(b.details?.urls) ?? 0;
  const label =
    bindings === 0
      ? one(urls === 0 ? 1 : urls, "Correct the probe's url", "Correct the probes' urls")
      : one(bindings + (urls > 0 ? 1 : 0), "Check the live binding's verify step", "Check the live bindings' verify steps");
  return setting("integrations", label)();
}

const NO_LINK = (): BlockerLink => null;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];

/** The display ids a list of objects carries under `key`, in the order the sentence names them. */
const idsAt = (v: unknown, key: string): string[] =>
  Array.isArray(v) ? strings(v.map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>)[key] : null))) : [];

const named = (displayIds: string[]): BlockerLink =>
  displayIds.length === 0 ? null : { kind: "issues", displayIds };

const NAMED_HERE = (b: Blocker): BlockerLink => named(strings(b.details?.displayIds));

/** One entry per code core sends, so a code it adds does not type-check until its link is decided.
 *  A code this screen does not know gets no link: a link onto a guessed list sends a person looking
 *  for nothing (ISS-1229 j16, j17). */
const BLOCKER_LINK: Record<ReleaseBlockerCode, (b: Blocker) => BlockerLink> = {
  NO_RELEASE_GATE: NO_LINK,
  RELEASE_TARGET_UNDECLARED: setting(ADD_LIVE_TARGET.tab, ADD_LIVE_TARGET.label, ADD_LIVE_TARGET.add),
  RELEASE_RUNNER_AMBIGUOUS: setting("integrations", "Reconcile the release runner labels"),
  RELEASE_PROBES_UNREADABLE: probesLink,
  RELEASE_POOL_EMPTY: setting("runners", "Assign a runner"),
  NO_RUNNER_ONLINE: (b) => setting("runners", one(countOf(b.details?.runners), "See the runner", "See the runners"))(),
  RELEASE_ROSTER_EMPTY: (b) => {
    const nearGate = b.details?.nearGate;
    if (typeof nearGate !== "number" || nearGate === 0) return null;
    return {
      kind: "statuses",
      statuses: ["testing", "tested"],
      label: `Open ${one(nearGate, "the issue", "the issues")} at ${ISSUE_STATUS_LABELS.testing} or ${ISSUE_STATUS_LABELS.tested}`,
    };
  },
  RELEASE_ROSTER_OVERSIZE: AT_AWAITING_RELEASE("waiting"),
  RELEASE_CRITERIA_UNEARNED: AT_AWAITING_RELEASE("held"),
  RELEASE_RUNTIME_UNROUTED: AT_AWAITING_RELEASE("held"),
  CLAIM_CONFLICT: (b) => named(idsAt(b.details?.conflicts, "key")),
  RELEASE_RECORD_MISSING: NAMED_HERE,
  RELEASE_WORK_UNMERGED: NAMED_HERE,
  RELEASE_ISSUES_UNCLOSABLE: NAMED_HERE,
  RELEASE_CUT_DROPS_ROSTER: NAMED_HERE,
  RELEASE_CARRIES_UNDECIDED: (b) => named(idsAt(b.details?.carried, "displayId")),
  RELEASE_CARRIED_DECISION_REFUSED: (b) => named(idsAt(b.details?.refused, "displayId")),
  BATCH_IN_FLIGHT: (b) => named(idsAt([b.details?.decision], "displayId")),
  RELEASE_CHECK_UNEVALUATED: NO_LINK,
};

function linkFor(b: Blocker): BlockerLink {
  return Object.hasOwn(BLOCKER_LINK, b.code) ? BLOCKER_LINK[b.code as ReleaseBlockerCode](b) : null;
}

/** One reading is taken per live target that declares a probe, so with several targets the answer is per target. */
function verifiedBy(r: ReleaseReadiness): string {
  if (r.providers.length > 1) {
    return r.hasVerify ? "a probe on each live target" : "a probe where one is declared — a target with none is named as not read, and with none declared anywhere the release closes unverified";
  }
  return r.hasVerify ? "a probe" : "nothing";
}

function answerText(r: ReleaseReadiness): ReactNode {
  const a = releaseAnswer(r);
  switch (a.kind) {
    case "unread":
      return "This project's release declaration could not be read just now, so nothing here is a reading of it.";
    case "ships-nothing":
      return "This project ships nothing: an issue closes when its work is done.";
    case "blocked":
      return `A release cannot start now: ${a.count} ${a.count === 1 ? "thing stops" : "things stop"} it.`;
    case "undeclared":
      return `A release can start, with ${a.count} ${a.count === 1 ? "thing" : "things"} left undeclared.`;
    case "ready":
      return "A release can start now.";
  }
}

/** The link a blocker's sentence earns, drawn after it; nothing where it earns none or no project is named. */
function BlockerLinkView({ link, slug }: { link: BlockerLink; slug?: string }) {
  if (!link || !slug) return null;
  const cls = "text-accent-text hover:underline";
  switch (link.kind) {
    case "setting":
      return (
        <Link href={`/projects/${slug}/settings?tab=${link.tab}${link.add ? `&add=${link.add}` : ""}`} className={cls}>
          {link.label}
        </Link>
      );
    case "statuses":
      return (
        <Link href={`/projects/${slug}/issues?status=${link.statuses.join(",")}`} className={cls}>
          {link.label}
        </Link>
      );
    case "issues":
      return (
        <span data-testid="release-named-issues">
          Open{" "}
          {link.displayIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <Link href={`/projects/${slug}/issues/${encodeURIComponent(id)}`} className={cls}>
                {id}
              </Link>
            </span>
          ))}
        </span>
      );
  }
}

/** What follows the answer: joined to a list the answer ends on, so the two share one divider. */
function After({ node, joined }: { node: ReactNode; joined: boolean }) {
  return node ? <div className={joined ? "-mt-px" : "mt-3"}>{node}</div> : null;
}

/** The answer line and every reason under it, each with a link to where it is set, then `after`. */
export function ReleaseAnswer({
  projectId,
  slug,
  after,
}: {
  projectId: string;
  slug?: string;
  after?: ReactNode;
}) {
  const q = useReleaseReadiness(projectId);
  const tab = (t: string, add?: string) =>
    slug ? `/projects/${slug}/settings?tab=${t}${add ? `&add=${add}` : ""}` : undefined;
  const knowledgeHref = slug ? `/projects/${slug}/library?tab=knowledge&sub=rules` : undefined;

  if (q.isLoading) {
    return (
      <>
        <div className="space-y-2" data-testid="release-answer">
          <Skeleton className="h-6 w-2/3 rounded-md" />
        </div>
        <After node={after} joined={false} />
      </>
    );
  }
  if (q.isError) {
    return (
      <div data-testid="release-answer">
        <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
        <After node={after} joined={false} />
      </div>
    );
  }
  const r = q.data;
  if (!r) return <After node={after} joined={false} />;
  const a = releaseAnswer(r);
  const listed = a.kind === "blocked" || a.kind === "undeclared" || a.kind === "unread";
  // A gap its own blocker already lists would be said twice, once as not stopping a release.
  const blocked = new Set(r.blockers.map((b) => BLOCKER_GAP[b.code]).filter(Boolean));
  const gaps = r.gaps.filter((g) => !blocked.has(g));
  const endsInList = listed && (r.blockers.length > 0 || gaps.length > 0);

  return (
    <div data-testid="release-answer" data-answer={a.kind}>
      <p className="fg-body text-fg">
        <b>Can this project release?</b> {answerText(r)}
      </p>
      {a.kind === "unread" && (
        <button
          type="button"
          className="fg-caption mt-1 text-accent-text hover:underline"
          onClick={() => q.refetch()}
        >
          Read it again
        </button>
      )}
      {listed && r.blockers.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-y border-line" aria-label="What stops a release">
          {r.blockers.map((b) => {
            const link = linkFor(b);
            // The person's sentence leads; the caller's and the code are for an API caller.
            const gap = BLOCKER_GAP[b.code];
            return (
              <li key={`${b.code}:${b.message}`} className="fg-body-sm py-2.5 text-fg" data-code={b.code}>
                {gap ? GAP_TEXT[gap] : inlineCode(b.reader)} <BlockerLinkView link={link} slug={slug} />
              </li>
            );
          })}
        </ul>
      )}
      {listed && gaps.length > 0 && (
        <>
          <p className="fg-caption mt-4 text-subtle">Not declared — none of these stops a release:</p>
          <ul className="mt-1 divide-y divide-line border-y border-line" aria-label="What is not declared">
            {gaps.map((g) => (
              <li key={g} className="fg-body-sm py-2.5 text-muted">
                {GAP_TEXT[g] ?? g}{" "}
                {FACT_GAPS.has(g) && knowledgeHref ? (
                  <Link href={knowledgeHref} className="text-accent-text hover:underline">
                    Write them in Knowledge rules
                  </Link>
                ) : g === "live-commit-endpoint" ? (
                  <a href="#environment-live" className="text-accent-text hover:underline">
                    Record the live commit endpoint
                  </a>
                ) : g === "release-target" && tab(ADD_LIVE_TARGET.tab) ? (
                  <Link
                    href={tab(ADD_LIVE_TARGET.tab, ADD_LIVE_TARGET.add) as string}
                    className="text-accent-text hover:underline"
                  >
                    {ADD_LIVE_TARGET.label}
                  </Link>
                ) : tab("integrations") ? (
                  <Link href={tab("integrations") as string} className="text-accent-text hover:underline">
                    Set it on the live binding
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <After node={after} joined={endsInList} />
    </div>
  );
}

/** What a release runs with, and what will change how it runs without stopping it. */
export function ReleaseDetails({ projectId }: { projectId: string }) {
  const q = useReleaseReadiness(projectId);
  const r = q.data;
  if (!r?.declarationRead) return null;

  return (
    <div data-testid="release-details">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="fg-caption text-subtle">Live targets</dt>
          <dd className="fg-body-sm text-fg">
            {!r.channelsRead ? UNREAD : r.providers.length > 0 ? r.providers.join(", ") : "none"}
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Release runner label</dt>
          <dd className="fg-body-sm text-fg">
            {!r.channelsRead ? (
              UNREAD
            ) : r.releaseRunnerLabel ? (
              <span className="font-mono">{r.releaseRunnerLabel}</span>
            ) : (
              NO_RELEASE_RUNNER_LABEL
            )}
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Rollback</dt>
          <dd className="fg-body-sm text-fg">
            {!r.channelsRead
              ? UNREAD
              : r.rollbackMode
                ? ROLLBACK_TEXT[r.rollbackMode]
                : "abort and comment"}
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Deploy verified by</dt>
          <dd className="fg-body-sm text-fg">{!r.channelsRead ? UNREAD : verifiedBy(r)}</dd>
        </div>
      </dl>

      {r.warnings.length > 0 && (
        <div className="mt-4">
          <h4 className="fg-caption text-subtle">
            What will change how the release runs, without stopping it
          </h4>
          <ul className="mt-1 divide-y divide-line border-y border-line">
            {r.warnings.map((w) => (
              <li key={`${w.code}:${w.message}`} className="fg-body-sm py-2.5 text-fg" data-code={w.code}>
                {inlineCode(w.reader)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
