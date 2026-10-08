"use client";

// The peek (`?peek=outreach`) beside the list: the shared PeekPanel holding the page's header, the
// one line whom the module waits on, its open issues by state and activity, then the same facts the
// full page's sticky rail shows.

import { CoverageBar, PeekHead, PeekPanel, type PeekState } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useModuleDetail } from "../hooks";
import { ActivityBars, AttentionBadge, ModuleAction, ModuleBanner, openSegments } from "./module-bits";
import { ModuleFacts } from "./module-facts";

export function ModulePeek({
  projectId,
  slug,
  moduleSlug,
  peek,
  onOpenFull,
}: {
  projectId: string;
  slug: string;
  moduleSlug: string;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const q = useModuleDetail(projectId, moduleSlug);
  return (
    <PeekPanel peek={peek} listLabel={t("modules.title")} noun={t("modules.noun")} onOpenFull={onOpenFull} testId="module-peek">
      <QueryBoundary query={q} loadingLabel={t("modules.loadingOne")}>
        {(d) => (
          <>
            <PeekHead noun={t("modules.noun")} itemKey={d.module.path} badge={<AttentionBadge group={d.standing.attentionGroup} />} title={d.module.name} action={<ModuleAction standing={d.standing} slug={slug} />} />
            {d.standing.attentionGroup !== "quiet" ? <ModuleBanner standing={d.standing} slug={slug} className="px-[18px]" /> : null}
            <div className="grid gap-4 px-[18px] pb-2 pt-4">
              {d.standing.open > 0 ? <CoverageBar segments={openSegments(d.standing, language)} /> : <p className="text-12-5 text-subtle">{t("modules.nothingOpen")}</p>}
              <div className="flex items-end justify-between gap-3">
                <span className="text-12-5 font-medium text-muted">{t("modules.lastDays", { n: d.activity.days.length })}</span>
                <ActivityBars days={d.activity.days} height={24} barWidth={7} />
              </div>
            </div>
            <div className="px-[18px] pb-4 pt-3">
              <ModuleFacts d={d} slug={slug} />
            </div>
          </>
        )}
      </QueryBoundary>
    </PeekPanel>
  );
}
