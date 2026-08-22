"use client";

// The run report — the body of a PIPELINE session's detail page.
//
// A pipeline session is not a conversation: nobody typed anything, and reading
// it as a chat thread means scrolling 400 tool calls to learn that one test
// failed. This lays the same transcript out as a report — blocker first, then
// three columns that scroll independently, then where the wall clock went.
//
// Interactive chat sessions keep the Conversation thread; `SessionScreen`
// picks between the two on `metadata.type`.

import { useMemo, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@/design";
import { formatDurationMs, formatUsd } from "@/features/pipeline/derive";
import { useRun } from "@/features/pipeline/hooks";
import type { SessionRow } from "@/features/sessions/types";
import {
  deriveActivityGroups,
  deriveBlocker,
  deriveTape,
  deriveTimeSpend,
  deriveTranscriptRows,
  readTranscriptMeta,
} from "../../run-report";
import { type ConversationItem, deriveFilesChanged } from "../../types";
import { BlockerCard } from "./blocker-card";
import { DiffLens } from "./diff-lens";
import { StepStrip } from "./step-strip";
import { StoryLens } from "./story-lens";
import { Tape } from "./tape";
import { TimeSpendBar } from "./time-spend-bar";
import { TranscriptLens } from "./transcript-lens";

type Lens = "story" | "diff" | "transcript";

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="fg-caption flex-1">{label}</span>
      <span className="fg-body-sm font-mono">{value}</span>
    </div>
  );
}

const LENSES: { key: Lens; label: string }[] = [
  { key: "story", label: "Story" },
  { key: "diff", label: "Diff" },
  { key: "transcript", label: "Transcript" },
];

export interface RunReportProps {
  session: SessionRow;
  items: ConversationItem[];
  onOpenIssue?: () => void;
}

export function RunReport({ session, items, onOpenIssue }: RunReportProps) {
  const [lens, setLens] = useState<Lens>("story");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const runQ = useRun(session.pipelineRunId ?? undefined, !!session.pipelineRunId);

  const groups = useMemo(() => deriveActivityGroups(items), [items]);
  const rows = useMemo(() => deriveTranscriptRows(items), [items]);
  const files = useMemo(() => deriveFilesChanged(items), [items]);
  const ticks = useMemo(() => deriveTape(items), [items]);
  const blocker = useMemo(() => deriveBlocker(items), [items]);
  const meta = useMemo(() => readTranscriptMeta(session.messages, items), [session.messages, items]);
  const spend = useMemo(() => deriveTimeSpend(session), [session]);

  function openFile(path: string) {
    setSelectedPath(path);
    setLens("diff");
  }

  if (items.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState title="No transcript yet" message="This step has not reported any activity." />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-6">
      {runQ.data && <StepStrip run={runQ.data} currentStep={session.metadata?.step} />}
      {blocker && <BlockerCard blocker={blocker} onOpenIssue={onOpenIssue} />}

      <div className="grid min-h-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)_280px]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Files changed</CardTitle>
              <span className="fg-caption">{files.length}</span>
            </CardHeader>
            <CardContent className="py-2">
              {files.length === 0 ? (
                <p className="fg-caption">Nothing was edited.</p>
              ) : (
                <ul className="space-y-0.5">
                  {files.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        onClick={() => openFile(file.path)}
                        className="flex w-full items-baseline gap-2 rounded-sm px-1 py-1 text-left hover:bg-hover"
                      >
                        <span className="fg-caption min-w-0 flex-1 truncate font-mono">{file.path}</span>
                        <span className="fg-caption font-mono" style={{ color: "var(--green-600)" }}>
                          +{file.added}
                        </span>
                        <span className="fg-caption font-mono" style={{ color: "var(--red-600)" }}>
                          −{file.removed}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="flex min-h-0 flex-col">
          <CardHeader>
            <div className="flex gap-1" role="tablist" aria-label="View">
              {LENSES.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  role="tab"
                  aria-selected={lens === l.key}
                  onClick={() => setLens(l.key)}
                  className="fg-body-sm rounded-sm px-2.5 py-1 hover:bg-hover"
                  style={
                    lens === l.key
                      ? { background: "var(--bg-active)", color: "var(--fg-default)" }
                      : { color: "var(--fg-subtle)" }
                  }
                >
                  {l.label}
                </button>
              ))}
            </div>
            <span className="fg-caption">
              {rows.length} tool calls
              {blocker ? ` · ${blocker.errorCount} errors` : ""}
            </span>
          </CardHeader>
          <div className="flex min-h-0 flex-1 gap-2 p-2">
            <div className="min-w-0 flex-1 overflow-y-auto">
              {lens === "story" && <StoryLens groups={groups} thinkingPauses={meta.thinkingPauses} />}
              {lens === "diff" && (
                <DiffLens files={files} selectedPath={selectedPath} onSelect={setSelectedPath} />
              )}
              {lens === "transcript" && <TranscriptLens rows={rows} />}
            </div>
            <Tape ticks={ticks} />
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Cost &amp; tokens</CardTitle>
              <span className="fg-caption">
                {formatUsd(meta.totals?.totalCostUsd ?? session.estimatedCost)}
              </span>
            </CardHeader>
            <CardContent className="space-y-1.5 py-2">
              <Figure label="Turns" value={String(meta.totals?.numTurns ?? session.usage?.turns ?? "—")} />
              <Figure
                label="API time"
                value={
                  meta.totals?.durationApiMs != null
                    ? `${formatDurationMs(meta.totals.durationApiMs)} of ${formatDurationMs(meta.totals.durationMs ?? null)}`
                    : "—"
                }
              />
              <Figure label="Permission denials" value={String(meta.totals?.permissionDenials ?? "—")} />
              <Figure label="Context used" value={String(session.usage?.contextUsed ?? "—")} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runner</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 py-2">
              <Figure label="Device" value={session.deviceId ? session.deviceId.slice(0, 8) : "—"} />
              <Figure label="Repo" value={session.repoPath ?? "—"} />
              {runQ.data?.retrySummary && (
                <Figure label="Attempts" value={String(runQ.data.retrySummary.totalAttempts)} />
              )}
            </CardContent>
          </Card>

          {onOpenIssue && (
            <Button variant="secondary" size="sm" icon="list" onClick={onOpenIssue}>
              Open issue
            </Button>
          )}
        </div>
      </div>

      {spend && <TimeSpendBar spend={spend} />}
    </div>
  );
}
