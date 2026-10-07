"use client";

import { useRouter } from "next/navigation";
import {
  Badge,
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  HealthDot,
  Icon,
} from "@/design";
import { runnerLimitLine } from "@/features/runners/types";
import { enumLabel } from "@/design/vocabulary";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { RunnersSummary } from "./derive";

export function RunnersCard({ summary, slug }: { summary: RunnersSummary; slug: string }) {
  const router = useRouter();
  const t = useCopy();
  const language = useInterfaceLanguage();
  const { lines, onlineCount, total } = summary;

  return (
    <PageSection className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle py-3">
        <div className="flex items-center gap-2">
          <Icon name="server" size={16} className="text-subtle" />
          <PageSectionTitle>{t("overview.runners.title")}</PageSectionTitle>
        </div>
        <span className="font-mono text-sm font-semibold tabular-nums text-fg">
          {t("overview.runners.online", { online: onlineCount, total })}
        </span>
      </div>
      <p className="fg-caption border-b border-line-subtle py-2 text-subtle">
        {t("overview.runners.bound")}
      </p>
      <PageSectionBody className="flex-1">
        {total === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">
            {t("overview.runners.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {lines.map((r) => (
              <li key={r.id} className="flex flex-col gap-0.5 px-0.5 py-1" data-testid="runner-line">
                <div className="flex items-center gap-2.5">
                  <HealthDot
                    health={r.limit ? r.limit.health : r.online ? "healthy" : "idle"}
                    withLabel={false}
                  />
                  <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{r.name}</span>
                  <span className="fg-caption flex-none text-subtle">{enumLabel("platform", r.platform, language)}</span>
                  {r.limit ? (
                    // ISS-276: why and since when, as the Runners screen says it; never a countdown to the printed reset
                    <Badge tone={r.limit.health === "down" ? "red" : "amber"}>
                      <span className="inline-flex items-center gap-1">
                        <Icon name="alert" size={10} />
                        {runnerLimitLine(r.limit)}
                      </span>
                    </Badge>
                  ) : r.activeIssueRef ? (
                    // Live: which issue (+ stage) this runner is executing now.
                    <span
                      className="fg-caption flex-none text-right font-semibold tabular-nums"
                      style={{ color: "var(--cobalt-700)" }}
                    >
                      {r.activeIssueRef}
                      {r.activeStage ? ` · ${enumLabel("jobType", r.activeStage, language)}` : ""}
                    </span>
                  ) : (
                    <span
                      className="fg-caption min-w-12 flex-none text-right font-semibold"
                      style={{ color: r.busy ? "var(--cobalt-700)" : "var(--fg-subtle)" }}
                    >
                      {t(`overview.runners.state.${r.draining ? "draining" : r.online ? (r.busy ? "busy" : "idle") : "offline"}`)}
                    </span>
                  )}
                </div>
                {r.limit?.printedText ? (
                  <p className="fg-caption pl-5 text-subtle">{r.limit.printedText}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PageSectionBody>
      <div className="flex items-center gap-4 border-t border-line-subtle py-2.5">
        <button
          type="button"
          onClick={() => router.push(`/projects/${slug}/agents`)}
          className="fg-caption inline-flex items-center gap-1 text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {t("overview.runners.agents")}
          <Icon name="arrowRight" size={13} />
        </button>
        <button
          type="button"
          onClick={() => router.push(`/projects/${slug}/settings?tab=connections#runners`)}
          className="fg-caption inline-flex items-center gap-1 text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {t("overview.runners.title")}
          <Icon name="arrowRight" size={13} />
        </button>
      </div>
    </PageSection>
  );
}
