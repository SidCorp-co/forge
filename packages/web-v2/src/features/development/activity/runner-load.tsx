
// The project's runners and what each is doing: online, busy on which issue and stage, limited and
// why (ISS-276: never a countdown to the reset its account printed).

import { cn } from "@/lib/utils/cn";
import { Link } from "@/lib/navigation/router";
import { Badge, enumLabel, HealthDot, Icon, RowItem, RowList, Section } from "@/design";
import { runnerLimitLine } from "@/features/runners";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { RunnerLine, RunnersSummary } from "./derive";

export function RunnerLoad({ summary, slug }: { summary: RunnersSummary; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const { lines, onlineCount, total } = summary;
  return (
    <Section
      title={t("overview.runners.title")}
      right={<span className="font-mono text-13 font-semibold tabular-nums text-fg">{t("overview.runners.online", { online: onlineCount, total })}</span>}
    >
      <p className="pb-2 text-12 text-subtle">{t("overview.runners.bound")}</p>
      {total === 0 ? (
        <p className="py-6 text-center text-13 text-muted">{t("overview.runners.empty")}</p>
      ) : (
        <RowList label={t("overview.runners.title")}>
          {lines.map((r) => (
            <RowItem
              key={r.id}
              testId="runner-line"
              lead={<HealthDot health={r.limit ? r.limit.health : r.online ? "healthy" : "idle"} withLabel={false} />}
              title={r.name}
              facts={[enumLabel("platform", r.platform, language)]}
              note={r.limit?.printedText}
              trailing={<RunnerState line={r} />}
            />
          ))}
        </RowList>
      )}
      <div className="flex items-center gap-4 pt-2.5">
        <Link href={`/projects/${slug}/agents`} className="inline-flex items-center gap-1 text-12 text-muted hover:text-fg">
          {t("overview.runners.agents")}
          <Icon name="arrowRight" size={13} />
        </Link>
        <Link href={`/projects/${slug}/settings?tab=connections#runners`} className="inline-flex items-center gap-1 text-12 text-muted hover:text-fg">
          {t("overview.runners.title")}
          <Icon name="arrowRight" size={13} />
        </Link>
      </div>
    </Section>
  );
}

/** What a runner is doing at the right of its line: its limit, the issue it works, or its state. */
function RunnerState({ line: r }: { line: RunnerLine }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  if (r.limit) {
    return (
      <Badge tone={r.limit.health === "down" ? "red" : "amber"}>
        <span className="inline-flex items-center gap-1">
          <Icon name="alert" size={10} />
          {runnerLimitLine(r.limit)}
        </span>
      </Badge>
    );
  }
  if (r.activeIssueRef) {
    return (
      <span className="text-12 font-semibold tabular-nums text-info-11">
        {r.activeIssueRef}
        {r.activeStage ? ` · ${enumLabel("jobType", r.activeStage, language)}` : ""}
      </span>
    );
  }
  const state = r.draining ? "draining" : r.online ? (r.busy ? "busy" : "idle") : "offline";
  return <span className={cn("text-12 font-semibold", r.busy ? "text-info-11" : "text-subtle")}>{t(`overview.runners.state.${state}`)}</span>;
}
