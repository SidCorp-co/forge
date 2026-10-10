"use client";

// RunDetail SlideOver (ISS-295) — an issue's pipeline run opens here rather
// than navigating away. Reordered for ISS-436 so it reads top-down as a
// status panel: header (title + issue meta) → run
// controls → History / Timeline / Cost tabs, all driven by
// `GET /api/pipeline-runs/:id` (`useRun`, WS-live via key
// `['pipeline-run', id]`). Pause/Resume/Cancel hit real endpoints; Rerun/Fork
// have NO backend (info toast, no phantom call).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  EmptyState,
  enumLabel,
  ErrorState,
  Icon,
  Menu,
  type MenuItem,
  MonoTag,
  ProgressBar,
  SectionTitle,
  SlideOver,
  Spinner,
  Stat,
  StatusBadge,
  Tabs,
  Tooltip,
  EnumBadge,
} from "@/design";
import { cn } from "@/lib/utils/cn";
import { formatApiError } from "@/lib/api/error";
import { useRecents } from "@/lib/navigation/recents";
import { copyShareLink } from "@/lib/navigation/copy-share-link";
import { IssueQuickActions } from "@/features/issues";
import { runStatusChip, workStepOf } from "@/features/issues";
import type { IssuePriority, IssueStatus } from "@/features/issues";
import { drawerRunChip } from "../derive";
import { useCancelRun, usePauseRun, useResumeRun } from "@/features/run-control";
import { useRun } from "../hooks";
import { ActivityTab } from "./activity-feed";
import { AskAboutThis } from "@/features/chat-dock";
import type {
  PipelineIssueRow,
  PipelineRunStepSummary,
  PipelineRunSummary,
} from "../types";
import { formatDuration, formatUsd } from "@/lib/i18n/format";

interface RunDetailProps {
  open: boolean;
  onClose: () => void;
  /** Full issue row when opened from the kanban; null when opened by runId
   *  alone (e.g. the Ops Runs tab) — the header then falls back to run data. */
  issue: PipelineIssueRow | null;
  /** Run to inspect (null when the issue has never run). */
  runId: string | null;
  /** Active project slug — enables the "Open issue" cross-link when present. */
  slug?: string;
  /** False for project viewers (read-only): hides the issue quick-action bar
   *  and the Pause/Resume/Stop run controls (the server 403s them anyway).
   *  Optional, defaults true so existing callers keep their behaviour. */
  canWrite?: boolean;
}

const TABS = [
  { value: "activity", label: "History" },
  { value: "timeline", label: "Timeline" },
  { value: "cost", label: "Cost" },
];

export function RunDetail({ open, onClose, issue, runId, slug, canWrite = true }: RunDetailProps) {
  const [tab, setTab] = useState("activity");
  const router = useRouter();
  const { push: pushRecent } = useRecents();
  const runQ = useRun(runId ?? undefined, open);

  const run = runQ.data;
  const taskIssueId = issue?.id ?? run?.issueId ?? null;

  // Track the opened run as recently-viewed (surfaces in the ⌘K Recent group).
  useEffect(() => {
    if (!open || !runId) return;
    pushRecent({
      kind: "run",
      id: runId,
      label: issue?.displayId ? `${issue.displayId} · run` : `run ${runId.slice(0, 8)}`,
      href: `/ops?run=${runId}`,
      icon: "pipeline",
    });
  }, [open, runId, issue?.displayId, pushRecent]);

  function copyLink() {
    if (!runId) return;
    copyShareLink(`/ops?run=${runId}`);
  }
  const chipStep = run?.currentStep ?? undefined;
  const label = issue?.displayId ?? (runId ? `run ${runId.slice(0, 8)}` : "run");
  // A session-styled chip is the run's; the issue's own status is never drawn in it.
  const issueRun = issue ? runStatusChip(issue) : null;
  const chipStatus = run ? drawerRunChip(run.status, issueRun) : issueRun;
  const runBadge = run && chipStatus === null ? run.status : null;
  const issueStatus = issue ? (issue.status as IssueStatus) : null;
  function openIssue() {
    if (!slug || !taskIssueId) return;
    onClose();
    router.push(`/projects/${slug}/issues/${taskIssueId}`);
  }

  const menuItems: MenuItem[] = [];
  // Related / Jump-to cross-links (run ↔ issue) + shareable deep-link. When an
  // issue row is present the quick-action bar already exposes a first-class
  // "Open issue" control, so the menu only carries it in the run-only context
  // (e.g. the Ops Runs tab, where there is no issue row + quick bar) — or for
  // read-only viewers, whose quick bar is hidden.
  if (slug && taskIssueId && (!issue || !canWrite)) {
    menuItems.push({ label: "Open issue", icon: "list", onSelect: openIssue });
  }
  if (runId) {
    menuItems.push({ label: "Copy link", icon: "link", onSelect: copyLink });
  }
  // NOTE: abort lives on the first-class "Stop now" control below (ISS-376), so
  // there is exactly one abort affordance — no duplicate "Cancel run" here.

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      width={520}
      title={
        <span className="flex items-center gap-2.5">
          <MonoTag>{label}</MonoTag>
          {/* Writers read the issue's status off the quick-actions row; a viewer has no such row. */}
          {issueStatus && !canWrite && (
            <StatusBadge family="issue" value={issueStatus} step={workStepOf(issue ?? {})} size="sm" />
          )}
          {chipStatus && <StatusBadge family="run" value={chipStatus} stage={chipStep} />}
          {runBadge && <StatusBadge family="pipelineRun" value={runBadge} />}
          {runBadge === "running" && chipStep && (
            <span className="fg-caption text-muted">{enumLabel("jobType", chipStep)}</span>
          )}
        </span>
      }
    >
      {!issue && !runId ? (
        <EmptyState title="No run selected" message="Pick a card to inspect its pipeline run." />
      ) : (
        <div className="flex flex-col gap-5">
          {/* Quick-action bar (ISS-390) — pinned at the top of the drawer so the
              most-used issue mutations (status / priority / assignee) + the
              full-detail link are reachable in one glance without scrolling.
              Only when opened from an issue card (the Ops run-only view has no
              issue row to edit) and for writers — viewers get a read-only
              drawer ("Open issue" moves into the overflow menu). */}
          {issue && canWrite && (
            <div className="sticky -top-4 z-10 -mx-5 -mt-4 border-b border-line bg-surface/95 px-5 pb-3 pt-4 backdrop-blur-sm">
              <IssueQuickActions
                issueId={issue.id}
                status={issue.status as IssueStatus}
                step={workStepOf(issue)}
                moves={issue.moves}
                agentStatus={issue.agentStatus ?? null}
                pipelineHealth={issue.pipelineHealth}
                priority={issue.priority as IssuePriority}
                slug={slug}
                onOpenIssue={openIssue}
              />
            </div>
          )}

          <RunHeading issue={issue} run={run} runId={runId} slug={slug} />

          <RunControls run={run} runId={runId} canWrite={canWrite} menuItems={menuItems} />

          {/* Tabs */}
          <div>
            <Tabs tabs={TABS} value={tab} onChange={setTab} />
            <div className="pt-4">
              {tab === "activity" ? (
                <ActivityTab
                  run={run}
                  loading={runQ.isLoading}
                  error={runQ.isError ? runQ.error : null}
                  onRetry={() => void runQ.refetch()}
                />
              ) : runQ.isError ? (
                <ErrorState message={formatApiError(runQ.error)} onRetry={() => void runQ.refetch()} />
              ) : tab === "timeline" ? (
                <TimelineTab run={run} loading={runQ.isLoading} />
              ) : (
                <CostTab run={run} loading={runQ.isLoading} />
              )}
            </div>
          </div>
        </div>
      )}
    </SlideOver>
  );
}

/* ── Timeline ─────────────────────────────────────────────────────────── */

type DotState = "done" | "running" | "error" | "todo";

function stepDot(status: PipelineRunStepSummary["status"]): DotState {
  if (status === "completed") return "done";
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "todo";
}

// ISS-509 — running is the info (cobalt) scale, not the flame accent.
const DOT_CLASS: Record<DotState, string> = {
  done: "border-ok-9 bg-ok-9",
  running: "border-info-9 bg-info-9 ring-4 ring-accent-tint",
  error: "border-danger-9 bg-danger-9",
  todo: "border-line-strong bg-surface",
};

const STEP_TEXT: Record<DotState, string> = {
  done: "text-ok-11",
  running: "text-accent-text",
  error: "text-danger-11",
  todo: "text-subtle",
};

function TimelineTab({ run, loading }: { run: PipelineRunSummary | undefined; loading: boolean }) {
  if (loading) return <PanelSpinner />;
  if (!run || run.steps.length === 0) {
    return <EmptyState title="No steps yet" message="This run hasn't recorded any agent handoffs." />;
  }
  return (
    <div>
      <p className="fg-overline mb-4">Agent handoffs</p>
      {run.steps.map((step, i) => {
        const state = stepDot(step.status);
        const isLast = i === run.steps.length - 1;
        return (
          <div key={step.jobType} className="flex gap-3">
            <div className="flex w-4.5 flex-none flex-col items-center">
              <span className={cn("mt-0.5 size-3.5 flex-none rounded-full border-2", DOT_CLASS[state])} />
              {!isLast && <span className={cn("mt-1 min-h-5.5 w-0.5 flex-1", state === "done" ? "bg-ok-9" : "bg-line")} />}
            </div>
            <div className="min-w-0 flex-1 pb-4">
              <div className="flex items-center gap-2.5">
                <span className={cn("font-mono text-13 font-bold", STEP_TEXT[state])}>
                  {enumLabel("jobType", step.jobType)}
                </span>
                <StatusBadge family="runStep" value={step.status} />
                {step.durationMs != null && (
                  <span className="ml-auto">
                    <Stat icon="clock">{formatDuration(step.durationMs)}</Stat>
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Cost ─────────────────────────────────────────────────────────────── */

function CostTab({ run, loading }: { run: PipelineRunSummary | undefined; loading: boolean }) {
  if (loading) return <PanelSpinner />;
  if (!run) return <EmptyState title="No cost data" message="This issue hasn't run yet." />;

  const steps = run.steps.filter((s) => s.durationMs != null);
  const maxDur = Math.max(1, ...steps.map((s) => s.durationMs ?? 0));
  const c = run.cost;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline gap-2">
        <span className="font-sans text-24 font-extrabold leading-none tracking-tight text-fg">
          {formatUsd(c.estimatedCost)}
        </span>
        <span className="fg-body-sm text-subtle">
          this run · {c.requests} request{c.requests === 1 ? "" : "s"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <TokenStat label="Input" value={c.inputTokens} />
        <TokenStat label="Output" value={c.outputTokens} />
        <TokenStat label="Cache read" value={c.cacheReadTokens} />
        <TokenStat label="Cache write" value={c.cacheCreationTokens} />
      </div>

      {steps.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <p className="fg-overline">Step durations</p>
          {steps.map((s) => (
            <div key={s.jobType} className="flex items-center gap-2.5">
              <span className="w-14 flex-none text-12 text-muted" title={`step: ${s.jobType}`}>
                {enumLabel("jobType", s.jobType)}
              </span>
              <ProgressBar
                className="flex-1"
                value={((s.durationMs ?? 0) / maxDur) * 100}
                tone="cobalt"
              />
              <span className="w-16 flex-none text-right font-mono text-12 text-fg">
                {formatDuration(s.durationMs)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TokenStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line-subtle bg-app px-3 py-2.5">
      <p className="fg-caption">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold text-fg">{value.toLocaleString()}</p>
    </div>
  );
}

function PanelSpinner() {
  return (
    <div className="grid place-items-center py-10">
      <Spinner size={22} />
    </div>
  );
}

/** Title, ask-about link and the issue's own meta (priority, branch, run cost), before any control (ISS-436). */
function RunHeading({ issue, run, runId, slug }: { issue: PipelineIssueRow | null; run: PipelineRunSummary | undefined; runId: string | null; slug?: string }) {
  const title = issue?.title ?? "Pipeline run";
  const branch = issue?.metadata?.branchConfig?.branch ?? null;
  return (
    <div className="flex flex-col gap-2.5">
      <SectionTitle className="leading-tight">{title}</SectionTitle>
      {slug && runId && (
        <div>
          <AskAboutThis about={{ kind: "run", ref: runId }} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        {issue && issue.priority !== "none" && (
          <EnumBadge family="priority" value={issue.priority} />
        )}
        {branch && (
          <MonoTag>
            <Icon name="branch" size={12} className="mr-1" />
            {branch}
          </MonoTag>
        )}
        {run && <Stat icon="dollar">{formatUsd(run.cost.estimatedCost)} this run</Stat>}
      </div>
    </div>
  );
}

/** Pause (finish the step, then halt) and Stop now (abort) — distinct in look and word — and the overflow menu. */
function RunControls({ run, runId, canWrite, menuItems }: { run: PipelineRunSummary | undefined; runId: string | null; canWrite: boolean; menuItems: MenuItem[] }) {
  const pause = usePauseRun();
  const resume = useResumeRun();
  const cancel = useCancelRun();
  // Pause is a "finish the in-flight step, then halt" gate (it does NOT abort
  // the running agent — only Cancel does). So a paused run with a step still
  // `running` is transitional ("Pausing…"); once that step clears it is fully
  // halted. `useRun` is WS-live, so the UI flips pausing→halted on its own.
  const activeStep = run?.steps.find((s) => s.status === "running") ?? null;
  const isPausing = run?.status === "paused" && !!activeStep;
  const isHalted = run?.status === "paused" && !activeStep;

  // "Stop now" is the only abort path (wired to the existing cancel mutation).
  // Guard the destructive click with a lightweight inline two-step confirm —
  // there is no Dialog primitive in the kit and Stop is terminal.
  const [confirmStop, setConfirmStop] = useState(false);
  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 3000);
    return () => clearTimeout(t);
  }, [confirmStop]);
  function onStopClick() {
    if (!runId) return;
    if (!confirmStop) {
      setConfirmStop(true);
      return;
    }
    setConfirmStop(false);
    cancel.mutate(runId);
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {canWrite && run?.status === "running" && (
          <Tooltip label="Finishes the in-flight step, then halts before the next step. Does NOT stop the running agent.">
            <Button
              variant="primary"
              icon="pause"
              loading={pause.isPending}
              onClick={() => runId && pause.mutate(runId)}
            >
              Pause run
            </Button>
          </Tooltip>
        )}
        {canWrite && run?.status === "paused" && (
          <Button
            variant="primary"
            icon="play"
            loading={resume.isPending}
            onClick={() => runId && resume.mutate(runId)}
          >
            Resume run
          </Button>
        )}
        {/* Distinct destructive abort — present whenever an agent could
            still be running (running, or the finishing step while pausing). */}
        {canWrite && runId && (run?.status === "running" || isPausing) && (
          <Tooltip label="Aborts the running agent immediately (cancellationRequested + agent:abort). Terminal — the run cannot be resumed.">
            <Button
              variant="danger"
              icon="stop"
              loading={cancel.isPending}
              onClick={onStopClick}
            >
              {confirmStop ? "Confirm stop" : "Stop now"}
            </Button>
          </Tooltip>
        )}
        <Menu
          align="left"
          trigger={
            <Button variant="ghost" icon="more" aria-label="More run actions" className="px-2.5" />
          }
          items={menuItems}
        />
      </div>

      {/* Transitional vs fully-halted state for a paused run (ISS-376). */}
      {isPausing && (
        <p
          className="fg-body-sm inline-flex items-center gap-2"
          style={{ color: "var(--warn-11)" }}
        >
          <span
            aria-hidden
            className="forge-pulse inline-block size-2 flex-none rounded-full"
            style={{ background: "var(--warn-9)" }}
          />
          Pausing — finishing current step: {activeStep?.jobType ?? "the in-flight step"}…
        </p>
      )}
      {isHalted && (
        <p className="fg-body-sm text-muted">Run halted — no active session.</p>
      )}
    </div>
  );
}
