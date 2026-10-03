"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageTitle } from "@/design";
import { useChatDockDoor } from "@/features/conversations/dock";
import { useRequirement } from "../hooks";
import { listOrigin, requirementsHref } from "../routes";
import { RequirementPage } from "./requirement-detail";
import { useAssistantDoor } from "./requirement-actions";

// cm:why the back control returns to the list view the page was opened from (its group, search and
// peek ride the URL); there is no breadcrumb, and the top bar's Ask Agent opens this requirement's
// BA assistant room through the ISS-58 door
export function RequirementScreen({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  const q = useRequirement(projectId, reqKey);
  const [back, setBack] = useState(requirementsHref(slug));
  useEffect(() => setBack(listOrigin(slug)), [slug]);
  useChatDockDoor(useAssistantDoor(projectId, reqKey));
  return (
    <div className="min-h-full bg-surface" data-testid="requirement-screen">
      <PageTitle
        back={
          <Link
            href={back}
            className="inline-flex h-[30px] flex-none items-center gap-1.5 whitespace-nowrap rounded-sm bg-sunken pl-2 pr-2.5 text-13 font-semibold text-fg hover:bg-active"
            data-testid="requirement-back"
          >
            <span aria-hidden className="text-[15px] leading-none text-muted">
              ←
            </span>
            Requirements
          </Link>
        }
      >
        {q.data?.title ?? reqKey}
      </PageTitle>
      <RequirementPage projectId={projectId} slug={slug} reqKey={reqKey} />
    </div>
  );
}
