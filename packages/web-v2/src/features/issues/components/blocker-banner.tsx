"use client";

import type { IssueBlocker } from "@forge/contracts/issue-standing";
import { Banner, Button } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said, saidOrNull } from "@/lib/i18n/said";
import type { IssueStatus } from "../types";
import { IssueRefBadge } from "./issue-ref-badge";

interface BlockerBannerProps {
  blocker: IssueBlocker;
  slug: string;
  pending: boolean;
  /** Move the issue back to the status its park left — `needs_info` or `on_hold` (ISS-1310, ISS-54). */
  onResumePark: (to: IssueStatus) => void;
  onResumeRun: (runId: string) => void;
  onProvideInfo: () => void;
}

export function BlockerBanner({
  blocker,
  slug,
  pending,
  onResumePark,
  onResumeRun,
  onProvideInfo,
}: BlockerBannerProps) {
  const { act: cta, runId, resumeAt } = blocker;
  const t = useCopy();
  const language = useInterfaceLanguage();
  const label = said(blocker.says.act, language);
  const detail = saidOrNull(blocker.says.detail, language);

  let action: React.ReactNode = null;
  if (cta.kind === "resume_park" && resumeAt) {
    action = (
      <Button
        variant="primary"
        size="sm"
        icon="rerun"
        loading={pending}
        onClick={() => onResumePark(resumeAt)}
      >
        {label}
      </Button>
    );
  } else if (cta.kind === "provide_info") {
    action = (
      <Button variant="primary" size="sm" icon="mail" onClick={onProvideInfo}>
        {label}
      </Button>
    );
  } else if (cta.kind === "resume_run" && runId) {
    action = (
      <Button
        variant="primary"
        size="sm"
        icon="rerun"
        loading={pending}
        onClick={() => onResumeRun(runId)}
      >
        {label}
      </Button>
    );
  }

  return (
    <Banner tone={blocker.tone} action={action ?? undefined}>
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
