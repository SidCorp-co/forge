
// The peek (`?peek=outreach`) beside the list: the shared PeekPanel holding the page's header, the
// one line whom the module waits on, its open issues by state and activity, then the same facts the
// full page's sticky rail shows.

import { CoverageBar, PeekHead, PeekPanel, type PeekState } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useModuleDetail } from "../hooks";
import { ActivityBars, AttentionBadge, ModuleAction, ModuleBanner, openSegments } from "./module-bits";
import { ModuleProperties } from "./module-facts";

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
            {d.standing.attentionGroup !== "quiet" ? <ModuleBanner standing={d.standing} slug={slug} className="px-4.5" /> : null}
            <div className="grid gap-4 px-4.5 pb-2 pt-4">
              {d.standing.open > 0 ? <CoverageBar segments={openSegments(d.standing, language)} /> : <p className="text-13 text-subtle">{t("modules.nothingOpen")}</p>}
              <div className="flex items-end justify-between gap-3">
                <span className="text-13 font-medium text-muted">{t("modules.lastDays", { n: d.activity.days.length })}</span>
                <ActivityBars days={d.activity.days} height={24} barWidth={7} />
              </div>
            </div>
            <div className="px-4.5 pb-4 pt-3">
              <ModuleProperties d={d} slug={slug} />
            </div>
          </>
        )}
      </QueryBoundary>
    </PeekPanel>
  );
}
