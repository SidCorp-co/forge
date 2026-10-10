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

import { useState } from "react";
import { Button, EmptyState, Property, PropertyList, Section, SegmentedControl, useUrlChoice } from "@/design";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useRun } from "@/features/pipeline";
import { useSessionCost } from "@/features/sessions";
import type { SessionRow } from "@/features/sessions";
import type { FileDiff } from "../../derive";
import {
  deriveActivityGroups,
  deriveNarration,
  deriveBlocker,
  deriveTape,
  deriveTimeSpend,
  deriveTranscriptRows,
  readTranscriptMeta,
  shortenPath,
} from "../../run-report";
import { deriveFilesChanged } from "../../derive";
import type { ConversationItem } from "../../types";
import { BlockerNotice } from "./blocker-notice";
import { DiffLens } from "./diff-lens";
import { StepStrip } from "./step-strip";
import { StoryLens } from "./story-lens";
import { Tape } from "./tape";
import { TimeSpendBar } from "./time-spend-bar";
import { TranscriptLens } from "./transcript-lens";
import { formatDuration, formatUsd } from "@/lib/i18n/format";

const LENSES = ["story", "diff", "transcript"] as const;
type Lens = (typeof LENSES)[number];

const LENS_LABEL: Record<Lens, ProductCopyKey> = {
  story: "runs.report.lens.story",
  diff: "runs.report.lens.diff",
  transcript: "runs.report.lens.transcript",
};

export interface RunReportProps {
  session: SessionRow;
  items: ConversationItem[];
  onOpenIssue?: () => void;
}

/** The files the run edited, each opening its diff. */
function FilesChanged({ files, repoPath, onOpen }: { files: FileDiff[]; repoPath: string | null; onOpen: (path: string) => void }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <Section title={t("runs.report.files")} right={<span className="fg-caption">{time.number(files.length)}</span>}>
      {files.length === 0 ? (
        <p className="fg-caption">{t("runs.report.noEdits")}</p>
      ) : (
        <ul className="space-y-0.5">
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onOpen(file.path)}
                className="flex w-full items-baseline gap-2 rounded-sm px-1 py-1 text-left hover:bg-hover"
              >
                <span className="fg-caption min-w-0 flex-1 truncate font-mono" dir="rtl" title={file.path}>
                  {shortenPath(file.path, repoPath)}
                </span>
                <span className="fg-caption font-mono text-ok-11">+{time.number(file.added)}</span>
                <span className="fg-caption font-mono text-danger-11">−{time.number(file.removed)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** What the run cost: turns, API time, denials, tokens, cache and model. */
function RunCost({ session, meta }: { session: SessionRow; meta: ReturnType<typeof readTranscriptMeta> }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const costQ = useSessionCost(session.id);
  const cost = costQ.data;
  const totals = meta.totals;
  return (
    <Section title={t("runs.report.costTokens")} right={<span className="fg-caption">{formatUsd(totals?.totalCostUsd ?? cost?.estimatedCost, language)}</span>}>
      <PropertyList>
        <Property label={t("runs.report.turns")}>{String(totals?.numTurns ?? session.usage?.turns ?? "—")}</Property>
        <Property label={t("runs.report.apiTime")}>
          {totals?.durationApiMs != null
            ? t("runs.report.apiOf", { api: formatDuration(totals.durationApiMs, language), total: formatDuration(totals.durationMs ?? null, language) })
            : "—"}
        </Property>
        <Property label={t("runs.report.denials")}>{String(totals?.permissionDenials ?? "—")}</Property>
        <Property label={t("runs.report.tokens")}>{cost ? `${time.compact(cost.inputTokens)} / ${time.compact(cost.outputTokens)}` : "—"}</Property>
        <Property label={t("runs.report.cache")}>{cost ? `${time.compact(cost.cacheReadTokens)} / ${time.compact(cost.cacheCreationTokens)}` : "—"}</Property>
        <Property label={t("runs.report.model")}>{cost?.models[0]?.model ?? "—"}</Property>
      </PropertyList>
    </Section>
  );
}

/** Where the run ran: its device, repo and attempts. */
function RunWhere({ session, attempts }: { session: SessionRow; attempts: number | undefined }) {
  const t = useCopy();
  return (
    <Section title={t("runs.report.runner")}>
      <PropertyList>
        <Property label={t("runs.report.device")}>{session.deviceId ? session.deviceId.slice(0, 8) : "—"}</Property>
        <Property label={t("runs.report.repo")}>{session.repoPath ?? "—"}</Property>
        {attempts !== undefined && <Property label={t("runs.report.attempts")}>{String(attempts)}</Property>}
      </PropertyList>
    </Section>
  );
}

export function RunReport({ session, items, onOpenIssue }: RunReportProps) {
  const t = useCopy();
  const time = useTimeFormat();
  const [lens, setLens] = useUrlChoice<Lens>("lens", LENSES, "story");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const runQ = useRun(session.pipelineRunId ?? undefined, !!session.pipelineRunId);

  const groups = deriveActivityGroups(items, t);
  const rows = deriveTranscriptRows(items, t);
  const files = deriveFilesChanged(items);
  const blocker = deriveBlocker(items, t);
  const meta = readTranscriptMeta(session.messages, items);
  const spend = deriveTimeSpend(session, t);

  function openFile(path: string) {
    setSelectedPath(path);
    setLens("diff");
  }

  if (items.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState message={t("runs.report.empty")} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-6">
      {runQ.data && <StepStrip run={runQ.data} currentStep={session.metadata?.step ?? (session.metadata?.jobType as string | undefined)} />}
      {blocker && <BlockerNotice blocker={blocker} onOpenIssue={onOpenIssue} />}

      <div className="flex min-h-0 flex-col gap-6 lg:flex-row">
        <div className="lg:w-60 lg:flex-none">
          <FilesChanged files={files} repoPath={session.repoPath} onOpen={openFile} />
        </div>

        <Section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("runs.report.view")}>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <SegmentedControl options={LENSES.map((l) => ({ value: l, label: t(LENS_LABEL[l]) }))} value={lens} onChange={setLens} />
            <span className="fg-caption ml-auto">
              {t("runs.report.toolCalls", { n: time.number(rows.filter((r) => r.kind === "tool").length) })}
              {blocker ? t("runs.report.errors", { n: time.number(blocker.errorCount) }) : ""}
            </span>
          </div>
          <div className="flex min-h-0 flex-1 gap-2">
            <div className="min-w-0 flex-1 overflow-y-auto">
              {lens === "story" && (
                <StoryLens groups={groups} thinkingPauses={meta.thinkingPauses} narration={deriveNarration(items)} onOpenTranscript={() => setLens("transcript")} />
              )}
              {lens === "diff" && <DiffLens files={files} selectedPath={selectedPath} onSelect={setSelectedPath} repoPath={session.repoPath} />}
              {lens === "transcript" && <TranscriptLens rows={rows} />}
            </div>
            <Tape ticks={deriveTape(items)} />
          </div>
        </Section>

        <div className="flex flex-col gap-4 lg:w-70 lg:flex-none">
          <RunCost session={session} meta={meta} />
          <RunWhere session={session} attempts={runQ.data?.retrySummary?.totalAttempts} />
          {onOpenIssue && (
            <Button variant="secondary" size="sm" icon="list" onClick={onOpenIssue}>
              {t("runs.report.openIssue")}
            </Button>
          )}
        </div>
      </div>

      {spend && <TimeSpendBar spend={spend} />}
    </div>
  );
}
