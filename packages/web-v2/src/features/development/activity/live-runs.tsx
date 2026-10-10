
// The runs working now: each row its stage colour, state, issue and spend, opening the issue (or the
// pipeline for a run without one). Runs still open with no live job show as a count under the list
// (ISS-789), never hidden.

import { Link } from "@/lib/navigation/router";
import { enumLabel, Icon, LiveDot, RowItem, RowList, Section, StatusBadge } from "@/design";
import { stageColor } from "@/design/stages";
import type { PipelineRunKind, PipelineRunListItem } from "@/features/pipeline";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { formatUsd } from "@/lib/i18n/format";

const KINDS: readonly PipelineRunKind[] = ["issue", "interactive", "system"];
function runLabel(kind: PipelineRunKind, t: Copy): string {
  return KINDS.includes(kind) ? t(`overview.runKind.${kind}`) : t("overview.runKind.other", { kind });
}

export function LiveRuns({ runs, slug, idle = [] }: { runs: PipelineRunListItem[]; slug: string; idle?: PipelineRunListItem[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (
    <Section title={t("overview.live.title")} right={<LiveDot state={runs.length > 0 ? "live" : "offline"} />}>
      {runs.length === 0 ? (
        <p className="py-6 text-center text-13 text-muted">{t("overview.live.empty")}</p>
      ) : (
        <RowList label={t("overview.live.title")}>
          {runs.map((run) => (
            <RowItem
              key={run.id}
              href={run.issueId ? `/projects/${slug}/issues/${run.issueId}` : `/projects/${slug}/pipeline`}
              lead={<span className="size-2 rounded-full" style={{ background: stageColor(run.currentStep ?? "") }} />}
              title={
                run.issueRef ? (
                  <>
                    <span className="font-mono">{run.issueRef}</span>
                    {run.issueTitle ? ` ${run.issueTitle}` : ""}
                  </>
                ) : (
                  runLabel(run.kind, t)
                )
              }
              facts={run.status === "running" && run.currentStep ? [enumLabel("jobType", run.currentStep, language)] : undefined}
              trailing={
                <>
                  <StatusBadge family="pipelineRun" value={run.status} />
                  <span className="font-mono text-13 font-semibold tabular-nums text-fg">{formatUsd(run.cost?.estimatedCost)}</span>
                </>
              }
            />
          ))}
        </RowList>
      )}
      {idle.length > 0 && (
        <Link href={`/projects/${slug}/pipeline`} className="mt-3 flex items-center gap-1.5 px-3 py-2 text-12 text-muted hover:bg-hover">
          <Icon name="pause" size={13} className="flex-none text-subtle" />
          <span className="min-w-0 flex-1">{idle.length === 1 ? t("overview.live.idleOne") : t("overview.live.idleMany", { n: idle.length })}</span>
          <Icon name="chevronRight" size={13} className="flex-none text-subtle" />
        </Link>
      )}
    </Section>
  );
}
