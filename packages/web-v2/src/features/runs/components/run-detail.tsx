"use client";

// RunDetail SlideOver (ISS-295) — the Ops Runs tab opens a pipeline run here
// rather than navigating away. Reads top-down as a status panel (ISS-436):
// header (title + run cost) → run controls → Activity / Timeline / Cost tabs, all driven by
// `GET /api/pipeline-runs/:id` (`useRun`, WS-live via key
// `['pipeline-run', id]`). Every control and menu item hits a real endpoint or link.

import { jobKindLabel } from "@/features/overview/job-kinds";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  EmptyState,
  ErrorState,
  Menu,
  MonoTag,
  ProgressBar,
  SectionTitle,
  SlideOver,
  Spinner,
  Stat,
  StatusChip,
  Tabs,
  Tooltip,
  type MenuItem,
} from "@/design";
import { useNow } from "@/design/hooks/use-now";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useRecents, buildShareLink } from "@/features/shell";
import {
  CANCEL_HELD_HOVER,
  CANCEL_STUCK_HOLD_HOVER,
  CANCEL_UNSTARTED_HOVER,
  STOP_NOW_HOVER,
} from "@/features/sessions/status-sentences";
import { runHasStarted, runReadingChip } from "../derive";
import { RUN_KIND_WORD } from "../run-status-words";
import { formatDurationMs, formatUsd } from "@/lib/utils/format";
import { useCancelRun, usePauseRun, useResumeRun, useRun } from "../hooks";
import { ActivityTab } from "./activity-feed";
import type {
  PipelineRunStepSummary,
  PipelineRunSummary,
} from "../types";

interface RunDetailProps {
  open: boolean;
  onClose: () => void;
  /** Run to inspect (null when the issue has never run). */
  runId: string | null;
  /** False for project viewers (read-only): hides the Pause/Resume/Stop run
   *  controls (the server 403s them anyway).
   *  Optional, defaults true so existing callers keep their behaviour. */
  canWrite?: boolean;
}

const TABS = [
  { value: "activity", label: "Activity" },
  { value: "timeline", label: "Timeline" },
  { value: "cost", label: "Cost" },
];

function cancelHover(run: { reading?: string | null; hold?: { resumesItself: boolean } | null } | undefined): string {
  if (run?.reading !== "held") return CANCEL_UNSTARTED_HOVER;
  return run.hold?.resumesItself ? CANCEL_HELD_HOVER : CANCEL_STUCK_HOLD_HOVER;
}

export function RunDetail({ open, onClose, runId, canWrite = true }: RunDetailProps) {
  const [tab, setTab] = useState("activity");
  const { toast } = useToast();
  const router = useRouter();
  const { push: pushRecent } = useRecents();
  const runQ = useRun(runId ?? undefined, open);
  const pause = usePauseRun();
  const resume = useResumeRun();
  const cancel = useCancelRun();
  const now = useNow(10_000, open);

  const run = runQ.data;
  // The run's own project, never the active org's list: a copied link opens under any org (ISS-1228).
  const slug = run?.projectSlug;
  const issues = run ? runIssues(run) : [];
  const issueRef = issues.length === 1 ? (issues[0]?.ref ?? null) : null;

  // Track the opened run as recently-viewed (surfaces in the ⌘K Recent group).
  useEffect(() => {
    if (!open || !runId) return;
    pushRecent({
      kind: "run",
      id: runId,
      label: issueRef ? `${issueRef} · run` : `run ${runId.slice(0, 8)}`,
      href: `/ops?run=${runId}`,
      icon: "pipeline",
    });
  }, [open, runId, issueRef, pushRecent]);

  function copyLink() {
    if (!runId) return;
    const url = buildShareLink(`/ops?run=${runId}`);
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: "Link copied", description: url, tone: "success" }),
      () => toast({ title: "Couldn't copy link", tone: "error" }),
    );
  }
  const chipStep = run?.currentStep ? jobKindLabel(run.currentStep) : undefined;
  const label = issueRef ?? (runId ? `run ${runId.slice(0, 8)}` : "run");
  const title = runTitle(issues, run ? RUN_KIND_WORD[run.kind] : "Pipeline run");
  const chip = run ? runReadingChip(run, now) : null;
  // Pause and Stop now act on an agent at work, so only a run something has started offers them; an
  // open run nothing has started yet offers Cancel run, the one control it takes (ISS-1228).
  const hasStarted = run ? runHasStarted(run) : false;
  const canCancelUnstarted = run?.status === "running" && !hasStarted;
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

  function openIssue(href: string) {
    if (!slug) return;
    onClose();
    router.push(`/projects/${slug}/issues/${href}`);
  }

  const menuItems: MenuItem[] = [];
  // Related / Jump-to cross-links (run ↔ issue) + shareable deep-link.
  if (slug) {
    for (const issue of issues) {
      menuItems.push({
        label: issues.length === 1 ? "Open issue" : `Open ${issue.ref}`,
        icon: "list",
        onSelect: () => openIssue(issue.href),
      });
    }
  }
  if (runId) {
    menuItems.push({ label: "Copy link", icon: "link", onSelect: copyLink });
  }
  // NOTE: abort lives on the first-class "Stop now" / "Cancel run" control below (ISS-376), so
  // there is exactly one abort affordance — none in this menu.

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      width={520}
      title={
        <span className="flex items-center gap-2.5">
          <MonoTag>{label}</MonoTag>
          {/* The run's one word, the runs tab's too: the session vocabulary would read `paused` as idle. */}
          {chip &&
            (chip.detail ? (
              <Tooltip label={chip.detail}>
                <span className="inline-flex">
                  <StatusChip status={chip.status} stage={chipStep} size="sm" domain="session" label={chip.label} />
                </span>
              </Tooltip>
            ) : (
              <StatusChip status={chip.status} stage={chipStep} size="sm" domain="session" label={chip.label} />
            ))}
        </span>
      }
    >
      {!runId ? (
        <EmptyState title="No run selected" message="Pick a run to inspect it." />
      ) : (
        <div className="flex flex-col gap-5">
          {/* Header — title + run cost, so the panel answers "what is this"
              before offering controls (ISS-436). */}
          <div className="flex flex-col gap-2.5">
            <SectionTitle className="leading-tight">{title}</SectionTitle>
            <div className="flex flex-wrap items-center gap-2.5">
              {run && <Stat icon="dollar">{formatUsd(run.cost.estimatedCost)} this run</Stat>}
            </div>
          </div>

          {/* Controls — Pause (finish-then-halt) and Stop now (abort) are
              visually + verbally distinct: a primary Pause vs a danger Stop. */}
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {canWrite && hasStarted && (
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
              {canWrite && runId && (hasStarted || isPausing) && (
                <Tooltip label={STOP_NOW_HOVER}>
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
              {canWrite && runId && canCancelUnstarted && (
                <Tooltip label={cancelHover(run)}>
                  <Button
                    variant="danger"
                    icon="stop"
                    loading={cancel.isPending}
                    onClick={onStopClick}
                  >
                    {confirmStop ? "Confirm cancel" : "Cancel run"}
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
                Pausing — finishing current step: {activeStep ? jobKindLabel(activeStep.jobType) : "the in-flight step"}…
              </p>
            )}
            {isHalted && (
              <p className="fg-body-sm text-muted">Run halted — no active session.</p>
            )}
            {/* What a held or starting run waits for, said where the header word is read (ISS-1228). */}
            {chip?.detail && (run?.reading === "held" || run?.reading === "starting") && (
              <p data-run-wait className="fg-caption text-muted">{chip.detail}</p>
            )}
          </div>

          {/* Tabs */}
          <div>
            <Tabs tabs={TABS} value={tab} onChange={setTab} />
            <div className="pt-4">
              {tab === "activity" ? (
                <ActivityTab
                  run={run}
                  sessionHref={slug && run?.sessionId ? `/projects/${slug}/agents/${run.sessionId}` : null}
                  loading={runQ.isLoading}
                  error={runQ.isError ? runQ.error : null}
                  onRetry={() => runQ.refetch()}
                />
              ) : runQ.isError ? (
                <ErrorState title="Couldn't load this run" message={formatApiError(runQ.error)} onRetry={() => runQ.refetch()} />
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

/** One issue a run names: its key, where its page is, and its title where core knows it. */
interface RunIssue {
  ref: string;
  href: string;
  title: string | null;
}

/** The issues a run names: its own, else the group a box drove it over, each keyed and titled from
 *  what core answered (ISS-1228). A run session carries no issue of its own, only its group. */
function runIssues(run: PipelineRunSummary): RunIssue[] {
  if (run.issueId) {
    return [{ ref: run.issueRef ?? run.issueId.slice(0, 8), href: run.issueId, title: run.issueTitle }];
  }
  return run.group.issues.map((key) => ({
    ref: key,
    href: encodeURIComponent(key),
    title: run.groupTitles?.[key] ?? null,
  }));
}

/** A run is titled by its one issue; several are listed by key; none by its kind, as the runs tab names it. */
function runTitle(issues: RunIssue[], kindWord: string): string {
  if (issues.length === 1) return issues[0]?.title ?? issues[0]?.ref ?? kindWord;
  if (issues.length > 1) return issues.map((i) => i.ref).join(", ");
  return kindWord;
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
  // ISS-509 — running uses the pipeline-active (cobalt) token, not flame --accent.
  running: "var(--pipeline-active)",
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
          <div key={step.jobType} className="flex gap-3">
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
                  className="font-mono text-12-5 font-bold"
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
                  {jobKindLabel(step.jobType)}
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
        <span className="font-sans text-34 font-extrabold leading-none tracking-tight text-fg">
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
              <span className="w-28 flex-none break-words text-12 text-muted">{jobKindLabel(s.jobType)}</span>
              <ProgressBar
                className="flex-1"
                value={((s.durationMs ?? 0) / maxDur) * 100}
                tone="cobalt"
              />
              <span className="w-16 flex-none text-right font-mono text-12 text-fg">
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
