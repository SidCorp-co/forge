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
import { Button, PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle, EmptyState } from "@/design";
import { formatDurationMs, formatUsd } from "@/features/pipeline";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useRun } from "@/features/pipeline";
import { useSessionCost } from "@/features/sessions";
import type { SessionRow } from "@/features/sessions";
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

const LENSES: { key: Lens; label: ProductCopyKey }[] = [
  { key: "story", label: "runs.report.lens.story" },
  { key: "diff", label: "runs.report.lens.diff" },
  { key: "transcript", label: "runs.report.lens.transcript" },
];

export interface RunReportProps {
  session: SessionRow;
  items: ConversationItem[];
  onOpenIssue?: () => void;
}

export function RunReport({ session, items, onOpenIssue }: RunReportProps) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const [lens, setLens] = useState<Lens>("story");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const runQ = useRun(session.pipelineRunId ?? undefined, !!session.pipelineRunId);
  const costQ = useSessionCost(session.id);

  const groups = deriveActivityGroups(items, t);
  const rows = deriveTranscriptRows(items, t);
  const narration = deriveNarration(items);
  const files = deriveFilesChanged(items);
  const ticks = deriveTape(items);
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
      {runQ.data && (
        <StepStrip
          run={runQ.data}
          currentStep={
            (session.metadata?.step) ??
            (session.metadata?.jobType as string | undefined)
          }
        />
      )}
      {blocker && <BlockerCard blocker={blocker} onOpenIssue={onOpenIssue} />}

      <div className="grid min-h-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)_280px]">
        <div className="flex flex-col gap-4">
          <PageSection>
            <PageSectionHeader>
              <PageSectionTitle>{t("runs.report.files")}</PageSectionTitle>
              <span className="fg-caption">{time.number(files.length)}</span>
            </PageSectionHeader>
            <PageSectionBody className="py-2">
              {files.length === 0 ? (
                <p className="fg-caption">{t("runs.report.noEdits")}</p>
              ) : (
                <ul className="space-y-0.5">
                  {files.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        onClick={() => openFile(file.path)}
                        className="flex w-full items-baseline gap-2 rounded-sm px-1 py-1 text-left hover:bg-hover"
                      >
                        <span
                          className="fg-caption min-w-0 flex-1 truncate font-mono"
                          dir="rtl"
                          title={file.path}
                        >
                          {shortenPath(file.path, session.repoPath)}
                        </span>
                        <span className="fg-caption font-mono text-ok-11">
                          +{time.number(file.added)}
                        </span>
                        <span className="fg-caption font-mono text-danger-11">
                          −{time.number(file.removed)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </PageSectionBody>
          </PageSection>
        </div>

        <PageSection className="flex min-h-0 flex-col">
          <PageSectionHeader>
            <div className="flex gap-1" role="tablist" aria-label={t("runs.report.view")}>
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
                  {t(l.label)}
                </button>
              ))}
            </div>
            <span className="fg-caption">
              {t("runs.report.toolCalls", { n: time.number(rows.filter((r) => r.kind === "tool").length) })}
              {blocker ? t("runs.report.errors", { n: time.number(blocker.errorCount) }) : ""}
            </span>
          </PageSectionHeader>
          <div className="flex min-h-0 flex-1 gap-2 p-2">
            <div className="min-w-0 flex-1 overflow-y-auto">
              {lens === "story" && (
                <StoryLens
                  groups={groups}
                  thinkingPauses={meta.thinkingPauses}
                  narration={narration}
                  onOpenTranscript={() => setLens("transcript")}
                />
              )}
              {lens === "diff" && (
                <DiffLens
                  files={files}
                  selectedPath={selectedPath}
                  onSelect={setSelectedPath}
                  repoPath={session.repoPath}
                />
              )}
              {lens === "transcript" && <TranscriptLens rows={rows} />}
            </div>
            <Tape ticks={ticks} />
          </div>
        </PageSection>

        <div className="flex flex-col gap-4">
          <PageSection>
            <PageSectionHeader>
              <PageSectionTitle>{t("runs.report.costTokens")}</PageSectionTitle>
              <span className="fg-caption">
                {formatUsd(meta.totals?.totalCostUsd ?? costQ.data?.estimatedCost, language)}
              </span>
            </PageSectionHeader>
            <PageSectionBody className="space-y-1.5 py-2">
              <Figure label={t("runs.report.turns")} value={String(meta.totals?.numTurns ?? session.usage?.turns ?? "—")} />
              <Figure
                label={t("runs.report.apiTime")}
                value={
                  meta.totals?.durationApiMs != null
                    ? t("runs.report.apiOf", { api: formatDurationMs(meta.totals.durationApiMs, language), total: formatDurationMs(meta.totals.durationMs ?? null, language) })
                    : "—"
                }
              />
              <Figure label={t("runs.report.denials")} value={String(meta.totals?.permissionDenials ?? "—")} />
              <Figure
                label={t("runs.report.tokens")}
                value={
                  costQ.data
                    ? `${time.compact(costQ.data.inputTokens)} / ${time.compact(costQ.data.outputTokens)}`
                    : "—"
                }
              />
              <Figure
                label={t("runs.report.cache")}
                value={
                  costQ.data
                    ? `${time.compact(costQ.data.cacheReadTokens)} / ${time.compact(costQ.data.cacheCreationTokens)}`
                    : "—"
                }
              />
              <Figure label={t("runs.report.model")} value={costQ.data?.models[0]?.model ?? "—"} />
            </PageSectionBody>
          </PageSection>

          <PageSection>
            <PageSectionHeader>
              <PageSectionTitle>{t("runs.report.runner")}</PageSectionTitle>
            </PageSectionHeader>
            <PageSectionBody className="space-y-1.5 py-2">
              <Figure label={t("runs.report.device")} value={session.deviceId ? session.deviceId.slice(0, 8) : "—"} />
              <Figure label={t("runs.report.repo")} value={session.repoPath ?? "—"} />
              {runQ.data?.retrySummary && (
                <Figure label={t("runs.report.attempts")} value={String(runQ.data.retrySummary.totalAttempts)} />
              )}
            </PageSectionBody>
          </PageSection>

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
