"use client";

import { DetailHeader, StatusBadge, useListOrigin } from "@/design";
import { useChatDockDoor } from "@/features/chat-dock/dock";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRequirement } from "../hooks";
import { REQUIREMENTS_LIST, requirementsHref } from "@/lib/routes/requirements";
import { PrimaryActions, useAssistantDoor } from "./requirement-actions";
import { RequirementPage, useRequirementTab } from "./requirement-detail";

// The shell's top bar is the page's sticky header (the shared DetailHeader): the named back
// control, key, title and state, and the one primary act; the bar's Ask Agent opens this
// requirement's BA assistant room through the ISS-58 door
export function RequirementScreen({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  const t = useCopy();
  const q = useRequirement(projectId, reqKey);
  const [tab, setTab] = useRequirementTab();
  const back = useListOrigin(REQUIREMENTS_LIST, requirementsHref(slug));
  useChatDockDoor(useAssistantDoor(projectId, reqKey));
  const d = q.data;
  return (
    <div className="min-h-full bg-app" data-testid="requirement-screen">
      <DetailHeader
        back={{ href: back, label: t("requirements.title") }}
        itemKey={d?.key ?? reqKey}
        keyTitle={d?.id}
        title={d?.title ?? reqKey}
        badge={d ? <StatusBadge family="requirement" value={d.standing.state} /> : null}
        action={d ? <PrimaryActions projectId={projectId} slug={slug} d={d} onReview={() => setTab("revisions")} /> : null}
      />
      <RequirementPage projectId={projectId} slug={slug} reqKey={reqKey} tab={tab} onTab={setTab} />
    </div>
  );
}
