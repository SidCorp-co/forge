import type { IssueBlocker } from "@forge/contracts/issue-standing";
import { Banner } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said, saidOrNull } from "@/lib/i18n/said";
import { IssueRefBadge } from "./issue-ref-badge";

/**
 * Why the issue is not moving and who moves it, for the developer's view. It offers no button: a
 * person never resumes, answers on or reruns an issue here (REQ-68 BC-6); the master resumes a park
 * and a paused run, and a question is answered in Needs you, on the item it serves.
 */
export function BlockerBanner({ blocker, slug }: { blocker: IssueBlocker; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const detail = saidOrNull(blocker.says.detail, language);

  return (
    <Banner tone={blocker.tone}>
      <div className="space-y-1">
        <p className="font-medium">{said(blocker.says.reason, language)}</p>
        <p className="opacity-90">{said(blocker.says.whoMustAct, language)}</p>
        {detail && <p className="opacity-80">{detail}</p>}
        {blocker.blockingRefs.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="opacity-80">{t("issues.blocker.blockedBy")}</span>
            {blocker.blockingRefs.map((ref) => (
              <IssueRefBadge key={ref.key} id={ref.key} slug={slug} displayId={ref.key} title={ref.title} status={ref.status} />
            ))}
          </div>
        )}
      </div>
    </Banner>
  );
}
