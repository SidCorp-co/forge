"use client";

// Project-tier Improve tab (ISS-549) — rendered inside the Automation shell.
// Shows the message catalog (one card per registry entry), per-project toggle,
// mode/cadence config, and an expandable per-run log.
import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  IconButton,
  MonoTag,
  PageContainer,
  Select,
  Skeleton,
  Spinner,
  StatusChip,
  Toggle,
  Tooltip,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import {
  useImprovementMessages,
  useImprovementMessageRuns,
  useEnableImprovementMessage,
  useToggleImprovementMessage,
  useUpdateImprovementMessage,
  useRunImprovementMessage,
} from "../hooks";
import {
  CADENCE_PRESETS,
  CATEGORY_LABELS,
  MODE_OPTIONS,
  type ImprovementMessageEntry,
  type ScheduleRun,
} from "../types";
import { sessionStatusToChip } from "@/features/schedules/types";

interface ImproveScreenProps {
  scope: { projectId: string; canManage: boolean };
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** One past run in the expandable history panel. */
function RunItem({ run, slug }: { run: ScheduleRun; slug: string | undefined }) {
  const body = (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <Badge tone={run.trigger === "manual" ? "accent" : "neutral"}>{run.trigger}</Badge>
      <StatusChip status={sessionStatusToChip(run.status)} size="sm" domain="session" />
      <span className="fg-caption text-subtle">{fmtTime(run.startedAt)}</span>
      <span className="fg-caption font-mono text-subtle">{fmtDuration(run.durationSeconds)}</span>
      {run.failureReason && (
        <Tooltip label={run.failureReason}>
          <span className="fg-caption text-danger underline decoration-dotted">why?</span>
        </Tooltip>
      )}
      {slug && run.sessionId && (
        <span className="fg-caption text-accent">View session →</span>
      )}
    </div>
  );
  if (slug && run.sessionId) {
    return (
      <Link
        href={`/projects/${slug}/agents/${run.sessionId}`}
        className="block rounded-md px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        {body}
      </Link>
    );
  }
  return body;
}

/** Expandable run log for one message's schedule. */
function RunLog({
  projectId,
  scheduleId,
  slug,
}: {
  projectId: string;
  scheduleId: string;
  slug: string | undefined;
}) {
  const runsQ = useImprovementMessageRuns(projectId, scheduleId, true);
  const runs = runsQ.data?.runs ?? [];

  return (
    <div className="mt-3 border-t border-line-subtle pt-3">
      <p className="fg-label mb-1 text-subtle">Recent runs</p>
      {runsQ.isLoading && (
        <span className="inline-flex items-center gap-2 fg-caption text-subtle">
          <Spinner size={14} /> Loading runs…
        </span>
      )}
      {runsQ.isError && (
        <span className="fg-caption text-danger">
          Couldn&apos;t load run history — {formatApiError(runsQ.error)}
        </span>
      )}
      {!runsQ.isLoading && !runsQ.isError && runs.length === 0 && (
        <span className="fg-caption text-subtle">No runs yet.</span>
      )}
      {runs.length > 0 && (
        <div className="divide-y divide-line-subtle">
          {runs.map((r) => (
            <RunItem key={r.sessionId} run={r} slug={slug} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Inline enable form: mode + cadence pickers + Save. Shown when the card's
 *  toggle is flipped ON for a not-yet-enabled message. */
function EnableForm({
  entry,
  projectId,
  onCancel,
  onSave,
  disabled,
}: {
  entry: ImprovementMessageEntry;
  projectId: string;
  onCancel: () => void;
  onSave: (mode: "propose" | "auto", cron: string) => void;
  disabled: boolean;
}) {
  const [mode, setMode] = useState<"propose" | "auto">(entry.defaultMode);
  const [cadencePreset, setCadencePreset] = useState(CADENCE_PRESETS[0].cron);
  const [customCron, setCustomCron] = useState("");
  const isCustom = !CADENCE_PRESETS.some((p) => p.cron === cadencePreset);
  const resolvedCron = cadencePreset === "custom" ? customCron : cadencePreset;

  const cadenceOptions = [
    ...CADENCE_PRESETS.map((p) => ({ label: p.label, value: p.cron })),
    { label: "Custom", value: "custom" },
  ];

  function handlePresetChange(val: string) {
    if (val === "custom") {
      setCadencePreset("custom");
      setCustomCron("");
    } else {
      setCadencePreset(val);
    }
  }

  const activeCron = cadencePreset === "custom" ? customCron.trim() : cadencePreset;
  const canSave = activeCron.length > 0;

  return (
    <div className="mt-3 space-y-3 border-t border-line-subtle pt-3">
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[140px]">
          <p className="fg-label mb-1 text-subtle">Mode</p>
          <Select
            value={mode}
            options={MODE_OPTIONS}
            onChange={(v) => setMode(v as "propose" | "auto")}
            disabled={disabled}
          />
        </div>
        <div className="min-w-[160px]">
          <p className="fg-label mb-1 text-subtle">Cadence</p>
          <Select
            value={cadencePreset === "custom" ? "custom" : cadencePreset}
            options={cadenceOptions}
            onChange={handlePresetChange}
            disabled={disabled}
          />
        </div>
      </div>
      {cadencePreset === "custom" && (
        <div>
          <p className="fg-label mb-1 text-subtle">Cron expression</p>
          <input
            type="text"
            className="w-full rounded-md border border-line bg-surface px-3 py-2 fg-body-sm font-mono focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            placeholder="e.g. 0 9 * * 1"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            disabled={disabled}
          />
          <p className="fg-caption mt-1 text-subtle">
            Standard 5-field cron: min hour dom month dow
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || !canSave}
          onClick={() => onSave(mode, activeCron)}
        >
          Save
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Single message card. */
function MessageCard({
  entry,
  projectId,
  canManage,
  slug,
  onEnable,
  onToggle,
  onRun,
  mutationPending,
}: {
  entry: ImprovementMessageEntry;
  projectId: string;
  canManage: boolean;
  slug: string | undefined;
  onEnable: (templateKey: string, mode: "propose" | "auto", cron: string) => Promise<void>;
  onToggle: (scheduleId: string, enabled: boolean, messageKey: string) => void;
  onRun: (scheduleId: string) => Promise<void>;
  mutationPending: boolean;
}) {
  const [showEnableForm, setShowEnableForm] = useState(false);
  const [showRunLog, setShowRunLog] = useState(false);
  const [running, setRunning] = useState(false);

  const isEnabled = entry.enablement?.enabled ?? false;
  const hasSchedule = entry.enablement !== null;

  async function handleToggleOn() {
    if (hasSchedule) {
      onToggle(entry.enablement!.scheduleId, true, entry.key);
    } else {
      setShowEnableForm(true);
    }
  }

  function handleToggleOff() {
    if (hasSchedule) {
      onToggle(entry.enablement!.scheduleId, false, entry.key);
      setShowEnableForm(false);
    }
  }

  function handleToggle(next: boolean) {
    if (next) handleToggleOn();
    else handleToggleOff();
  }

  async function handleSaveEnable(mode: "propose" | "auto", cron: string) {
    await onEnable(entry.key, mode, cron);
    setShowEnableForm(false);
  }

  async function handleRun() {
    if (!entry.enablement) return;
    setRunning(true);
    try {
      await onRun(entry.enablement.scheduleId);
      setShowRunLog(true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardContent>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="fg-body-sm font-medium text-fg">{entry.title}</span>
              <Badge tone="neutral">{CATEGORY_LABELS[entry.category]}</Badge>
              {entry.standing && (
                <Badge tone="cobalt">Standing · runs continuously</Badge>
              )}
              {entry.recommended && (
                <Badge tone="accent">Recommended</Badge>
              )}
            </div>
            <p className="fg-caption text-muted line-clamp-2">{entry.rationale}</p>
          </div>
          {canManage && (
            <Toggle
              checked={isEnabled || showEnableForm}
              disabled={mutationPending}
              aria-label={`${isEnabled ? "Disable" : "Enable"} ${entry.title}`}
              onChange={handleToggle}
            />
          )}
        </div>

        {/* Active schedule info */}
        {hasSchedule && !showEnableForm && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <MonoTag>{entry.enablement!.cron}</MonoTag>
            <Badge tone="neutral">{entry.enablement!.mode}</Badge>
            {canManage && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="play"
                  disabled={mutationPending || running}
                  onClick={handleRun}
                >
                  {running ? "Running…" : "Run now"}
                </Button>
                <button
                  type="button"
                  onClick={() => setShowRunLog((o) => !o)}
                  className="fg-caption text-accent focus-visible:outline-none"
                >
                  {showRunLog ? "Hide log" : "Show log"}
                </button>
              </>
            )}
          </div>
        )}

        {/* Enable form */}
        {showEnableForm && canManage && (
          <EnableForm
            entry={entry}
            projectId={projectId}
            onCancel={() => setShowEnableForm(false)}
            onSave={handleSaveEnable}
            disabled={mutationPending}
          />
        )}

        {/* Run log */}
        {showRunLog && entry.enablement && (
          <RunLog
            projectId={projectId}
            scheduleId={entry.enablement.scheduleId}
            slug={slug}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function ImproveScreen({ scope }: ImproveScreenProps) {
  const { projectId, canManage } = scope;
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;

  const catalogQ = useImprovementMessages(projectId);
  const enableMut = useEnableImprovementMessage(projectId);
  const toggleMut = useToggleImprovementMessage(projectId);
  const runMut = useRunImprovementMessage(projectId);

  const entries = catalogQ.data ?? [];
  const mutationPending = enableMut.isPending || toggleMut.isPending || runMut.isPending;

  async function handleEnable(templateKey: string, mode: "propose" | "auto", cron: string) {
    await enableMut.mutateAsync({ projectId, templateKey, mode, cron });
  }

  function handleToggle(scheduleId: string, enabled: boolean, messageKey: string) {
    toggleMut.mutate({ scheduleId, enabled, messageKey });
  }

  async function handleRun(scheduleId: string) {
    await runMut.mutateAsync(scheduleId);
  }

  return (
    <PageContainer className="min-h-dvh">
      <header className="mb-6">
        <h1 className="fg-h2">Improve</h1>
        <p className="fg-body-sm mt-1">
          Enable improvement messages to automatically propose or apply skill refinements for this
          project.
        </p>
      </header>

      {catalogQ.isLoading && (
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      )}

      {catalogQ.isError && (
        <ErrorState
          title="Couldn't load improvement messages"
          message={formatApiError(catalogQ.error)}
          onRetry={() => catalogQ.refetch()}
        />
      )}

      {!catalogQ.isLoading && !catalogQ.isError && entries.length === 0 && (
        <EmptyState
          title="No messages in registry yet"
          message="Improvement messages will appear here once the registry is populated."
        />
      )}

      {!catalogQ.isLoading && !catalogQ.isError && entries.length > 0 && (
        <div className="space-y-3">
          {entries.map((entry) => (
            <MessageCard
              key={entry.key}
              entry={entry}
              projectId={projectId}
              canManage={canManage}
              slug={slug}
              onEnable={handleEnable}
              onToggle={handleToggle}
              onRun={handleRun}
              mutationPending={mutationPending}
            />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
