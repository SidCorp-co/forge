"use client";

import { useRouter } from "next/navigation";
import {
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  Icon,
  LiveDot,
  StatusBadge,
  enumLabel,
} from "@/design";
import { stageColor } from "@/design/stages";
import { formatUsd } from "@/features/pipeline/derive";
import type { PipelineRunKind, PipelineRunListItem } from "@/features/pipeline/types";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";

const KINDS: readonly PipelineRunKind[] = ["issue", "interactive", "system"];
function runLabel(kind: PipelineRunKind, t: Copy): string {
  return KINDS.includes(kind) ? t(`overview.runKind.${kind}`) : t("overview.runKind.other", { kind });
}

export function LiveRunsCard({
  runs,
  slug,
  idle = [],
}: {
  runs: PipelineRunListItem[];
  slug: string;
  /** ISS-789 — runs still open with no live JOB on them. Shown as a count
   *  rather than hidden: they were invisible before. */
  idle?: PipelineRunListItem[];
}) {
  const router = useRouter();
  const t = useCopy();
  const language = useInterfaceLanguage();

  const open = (run: PipelineRunListItem) => {
    router.push(run.issueId ? `/projects/${slug}/issues/${run.issueId}` : `/projects/${slug}/pipeline`);
  };

  return (
    <PageSection className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle py-3">
        <div className="flex items-center gap-2">
          <Icon name="pipeline" size={16} className="text-subtle" />
          <PageSectionTitle>{t("overview.live.title")}</PageSectionTitle>
        </div>
        <LiveDot state={runs.length > 0 ? "live" : "offline"} />
      </div>
      <PageSectionBody className="flex-1">
        {runs.length === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">{t("overview.live.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-subtle">
            {runs.map((run) => {
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => open(run)}
                    className="flex w-full items-center gap-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  >
                    <span className="size-2 flex-none rounded-full" style={{ background: stageColor(run.currentStep ?? "") }} />
                    <StatusBadge family="pipelineRun" value={run.status} />
                    {run.status === "running" && run.currentStep ? (
                      <span className="fg-caption flex-none text-muted">{enumLabel("jobType", run.currentStep, language)}</span>
                    ) : null}
                    <span className="fg-body-sm min-w-0 flex-1 truncate text-muted">
                      {run.issueRef ? (
                        <>
                          <span className="font-mono text-fg">{run.issueRef}</span>
                          {run.issueTitle ? ` ${run.issueTitle}` : ""}
                        </>
                      ) : (
                        runLabel(run.kind, t)
                      )}
                    </span>
                    <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                      {formatUsd(run.cost?.estimatedCost)}
                    </span>
                    <Icon name="chevronRight" size={14} className="flex-none text-subtle" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {idle.length > 0 && (
          <button
            type="button"
            onClick={() => router.push(`/projects/${slug}/pipeline`)}
            className="fg-caption mt-3 flex w-full items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-muted transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <Icon name="pause" size={13} className="flex-none text-subtle" />
            <span className="min-w-0 flex-1">
              {idle.length === 1 ? t("overview.live.idleOne") : t("overview.live.idleMany", { n: idle.length })}
            </span>
            <Icon name="chevronRight" size={13} className="flex-none text-subtle" />
          </button>
        )}
      </PageSectionBody>
    </PageSection>
  );
}
