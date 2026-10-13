
// A module named on an issue opens its overview on hover: what it is for, what stands in it now, and
// the way to its page. The detail is read only once the card opens.

import { Link } from "@/lib/navigation/router";
import { HoverCard, MonoTag } from "@/design";
import { useModuleDetail } from "@/features/modules";
import { useCopy } from "@/lib/i18n/interface-language";
import { moduleHref } from "@/lib/routes/modules";
import type { IssueLabel } from "../types";

function Overview({ projectId, slug, module }: { projectId: string; slug: string; module: IssueLabel }) {
  const t = useCopy();
  const key = module.slug ?? module.name;
  const q = useModuleDetail(projectId, key);
  const d = q.data;
  const purpose = d?.purpose.available ? d.purpose.value.summary : (d?.module.description ?? module.description ?? null);
  return (
    <div className="grid gap-1.5" data-testid="module-hover">
      <p className="font-semibold">{module.name}</p>
      {q.isLoading ? <p className="text-muted">{t("issues.module.loading")}</p> : null}
      {q.isError ? <p className="text-muted">{t("issues.module.loadFailed")}</p> : null}
      {purpose ? <p className="line-clamp-4 text-muted">{purpose}</p> : null}
      {d && !purpose ? <p className="text-muted">{t("issues.module.noOverview")}</p> : null}
      {d ? (
        <p className="border-t border-line-subtle pt-1.5 text-12 text-muted">
          {t("issues.module.standing", { open: d.standing.open, running: d.standing.running })}
        </p>
      ) : null}
      <Link href={moduleHref(slug, key)} className="text-13 text-link hover:underline">
        {t("issues.module.open")}
      </Link>
    </div>
  );
}

export function ModuleHover({ projectId, slug, module, primary }: { projectId: string; slug: string; module: IssueLabel; primary: boolean }) {
  const t = useCopy();
  return (
    <HoverCard label={t("issues.module.overviewOf", { name: module.name })} content={<Overview projectId={projectId} slug={slug} module={module} />}>
      <MonoTag hue={primary ? "cobalt" : undefined}>{module.name}</MonoTag>
    </HoverCard>
  );
}
