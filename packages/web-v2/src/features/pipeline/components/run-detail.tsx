"use client";

// RunDetail SlideOver (ISS-295) — an issue's pipeline run opens here rather
// than navigating away. Header → controls → full PipelineTracker → Timeline /
// Tasks / Cost tabs, all driven by `GET /api/pipeline-runs/:id` (`useRun`,
// WS-live via key `['pipeline-run', id]`). Pause/Resume/Cancel hit real
// endpoints; Rerun/Fork have NO backend (info toast, no phantom call). Mirrors
// the prototype `web-redesign-plan/ui-kit/RunDetail.jsx`.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  type MenuItem,
  Menu,
  MonoTag,
  PipelineTracker,
  ProgressBar,
  Spinner,
  Stat,
  StatusChip,
  SlideOver,
  Tabs,
  Tooltip,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useRecents, buildShareLink } from "@/features/shell";
import {
  formatDurationMs,
  formatUsd,
  issueStatusToStatusKey,
  jobTypeToStage,
  runStatusToStatusKey,
  runStatusToTracker,
  statusToStage,
} from "../derive";
import { useCancelRun, useIssueTasks, usePauseRun, useResumeRun, useRun } from "../hooks";
import type { PipelineIssueRow, PipelineRunStepSummary, PipelineRunSummary } from "../types";

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
}

const TABS = [
  { value: "timeline", label: "Timeline" },
  { value: "tasks", label: "Tasks" },
  { value: "cost", label: "Cost" },
];

export function RunDetail({ open, onClose, issue, runId, slug }: RunDetailProps) {
  const [tab, setTab] = useState("timeline");
  const { toast } = useToast();
  const router = useRouter();
  const { push: pushRecent } = useRecents();
  const runQ = useRun(runId ?? undefined, open);
  const pause = usePauseRun();
  const resume = useResumeRun();
  const cancel = useCancelRun();

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
    const url = buildShareLink(`/ops?run=${runId}`);
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: "Link copied", description: url, tone: "success" }),
      () => toast({ title: "Couldn't copy link", tone: "error" }),
    );
  }
  const label = issue?.displayId ?? (runId ? `run ${runId.slice(0, 8)}` : "run");
  const title = issue?.title ?? "Pipeline run";
  const branch = issue?.metadata?.branchConfig?.branch ?? null;
  const stage = run?.currentStep ? jobTypeToStage(run.currentStep) : statusToStage(issue?.status ?? "open");
  const trackerStatus = run ? runStatusToTracker(run.status) : "queued";
  const chipStatus = run
    ? runStatusToStatusKey(run.status)
    : issueStatusToStatusKey(issue?.status ?? "open");
  const isActive = run?.status === "running" || run?.status === "paused";
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

  const notSupported = (action: string) =>
    toast({ tone: "info", title: `${action} isn't supported yet` });

  const menuItems: MenuItem[] = [];
  // Related / Jump-to cross-links (run ↔ issue) + shareable deep-link.
  if (slug && taskIssueId) {
    menuItems.push({
      label: "Open issue",
      icon: "list",
      onSelect: () => {
        onClose();
        router.push(`/projects/${slug}/issues/${taskIssueId}`);
      },
    });
  }
  if (runId) {
    menuItems.push({ label: "Copy link", icon: "link", onSelect: copyLink });
  }
  menuItems.push(
    { label: "Rerun", icon: "rerun", onSelect: () => notSupported("Rerun") },
    { label: "Fork", icon: "fork", onSelect: () => notSupported("Fork") },
  );
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
          <StatusChip status={chipStatus} stage={stage} size="sm" domain="session" />
        </span>
      }
    >
      {!issue && !runId ? (
        <EmptyState title="No run selected" message="Pick a card to inspect its pipeline run." />
      ) : (
        <div className="flex flex-col gap-5">
          {/* Header */}
          <div className="flex flex-col gap-2.5">
            <h2 className="fg-h2 leading-tight">{title}</h2>
            <div className="flex flex-wrap items-center gap-2.5">
              {branch && (
                <MonoTag>
                  <Icon name="branch" size={12} className="mr-1 align-[-1px]" />
                  {branch}
                </MonoTag>
              )}
              {run && <Stat icon="dollar">{formatUsd(run.cost.estimatedCost)} this run</Stat>}
            </div>
          </div>

          {/* Controls — Pause (finish-then-halt) and Stop now (abort) are
              visually + verbally distinct: a primary Pause vs a danger Stop. */}
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {run?.status === "running" && (
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
              {run?.status === "paused" && (
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
              {runId && (run?.status === "running" || isPausing) && (
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
                style={{ color: "var(--amber-600)" }}
              >
                <span
                  aria-hidden
                  className="forge-pulse inline-block size-2 flex-none rounded-full"
                  style={{ background: "var(--amber-500)" }}
                />
                Pausing — finishing current step: {activeStep?.jobType ?? "the in-flight step"}…
              </p>
            )}
            {isHalted && (
              <p className="fg-body-sm text-muted">Run halted — no active session.</p>
            )}
          </div>

          {/* Full tracker */}
          <div className="rounded-lg border border-line-subtle bg-sunken p-4">
            <PipelineTracker stage={stage} status={trackerStatus} variant="full" />
          </div>

          {/* Tabs */}
          <div>
            <Tabs tabs={TABS} value={tab} onChange={setTab} />
            <div className="pt-4">
              {runQ.isError ? (
                <ErrorState message={formatApiError(runQ.error)} onRetry={() => runQ.refetch()} />
              ) : tab === "timeline" ? (
                <TimelineTab run={run} loading={runQ.isLoading} />
              ) : tab === "tasks" ? (
                <TasksTab issueId={taskIssueId} open={open} />
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

const DOT_COLOR: Record<DotState, string> = {
  done: "var(--green-500)",
  running: "var(--accent)",
  error: "var(--red-500)",
  todo: "var(--border-strong)",
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
          <div key={`${step.jobType}-${i}`} className="flex gap-3">
            <div className="flex w-[18px] flex-none flex-col items-center">
              <span
                className="mt-0.5 size-3.5 flex-none rounded-full"
                style={{
                  background: state === "todo" ? "var(--bg-surface)" : DOT_COLOR[state],
                  border: `2px solid ${DOT_COLOR[state]}`,
                  boxShadow: state === "running" ? "0 0 0 4px var(--accent-tint)" : "none",
                }}
              />
              {!isLast && (
                <span
                  className="mt-1 min-h-[22px] w-0.5 flex-1"
                  style={{
                    background: state === "done" ? "var(--green-500)" : "var(--border-default)",
                  }}
                />
              )}
            </div>
            <div className="min-w-0 flex-1 pb-4">
              <div className="flex items-center gap-2.5">
                <span
                  className="font-mono text-[12.5px] font-bold"
                  style={{
                    color:
                      state === "running"
                        ? "var(--accent-text)"
                        : state === "done"
                          ? "var(--green-600)"
                          : state === "error"
                            ? "var(--red-600)"
                            : "var(--fg-subtle)",
                  }}
                >
                  {step.jobType}
                </span>
                <span className="fg-body-sm capitalize text-muted">{step.status}</span>
                {step.durationMs != null && (
                  <span className="ml-auto">
                    <Stat icon="clock">{formatDurationMs(step.durationMs)}</Stat>
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

/* ── Tasks ────────────────────────────────────────────────────────────── */

function TasksTab({ issueId, open }: { issueId: string | null; open: boolean }) {
  const tasksQ = useIssueTasks(issueId ?? undefined, open && !!issueId);
  if (!issueId) {
    return <EmptyState title="No issue" message="This run isn't linked to an issue." />;
  }
  if (tasksQ.isLoading) return <PanelSpinner />;
  if (tasksQ.isError) {
    return <ErrorState message={formatApiError(tasksQ.error)} onRetry={() => tasksQ.refetch()} />;
  }
  const tasks = tasksQ.data ?? [];
  if (tasks.length === 0) {
    return <EmptyState title="No tasks" message="This issue has no subtasks yet." />;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {tasks.map((t) => {
        const done = t.status === "done";
        return (
          <div
            key={t.id}
            className="flex items-center gap-3 rounded-md border border-line-subtle bg-app px-3.5 py-3"
          >
            <span
              className="flex size-[18px] flex-none items-center justify-center rounded-[5px]"
              style={{
                background: done ? "var(--green-500)" : "var(--bg-surface)",
                border: `1.5px solid ${done ? "var(--green-500)" : "var(--border-strong)"}`,
              }}
            >
              {done && <Icon name="check" size={12} strokeWidth={3} style={{ color: "var(--fg-on-accent)" }} />}
            </span>
            <span
              className="fg-body-sm"
              style={{
                color: done ? "var(--fg-subtle)" : "var(--fg-default)",
                textDecoration: done ? "line-through" : "none",
              }}
            >
              {t.title}
            </span>
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
        <span className="font-sans text-[34px] font-extrabold leading-none tracking-tight text-fg">
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
          {steps.map((s, i) => (
            <div key={`${s.jobType}-${i}`} className="flex items-center gap-2.5">
              <span className="w-14 flex-none font-mono text-[12px] text-muted">{s.jobType}</span>
              <ProgressBar
                className="flex-1"
                value={((s.durationMs ?? 0) / maxDur) * 100}
                tone="cobalt"
              />
              <span className="w-16 flex-none text-right font-mono text-[12px] text-fg">
                {formatDurationMs(s.durationMs)}
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
