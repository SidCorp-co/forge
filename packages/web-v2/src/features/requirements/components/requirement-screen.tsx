"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageTitle, TopBarActions } from "@/design";
import { useChatDockDoor } from "@/features/conversations/dock";
import { useRequirement } from "../hooks";
import { listOrigin, requirementsHref } from "../routes";
import { useAssistantDoor, PrimaryActions } from "./requirement-actions";
import { RequirementPage, useRequirementTab } from "./requirement-detail";
import { StateBadge } from "./standing-bits";

// cm:why the shell's top bar is the page's sticky header: the named back control (no breadcrumb), key,
// title and state, and the one primary act; the bar's Ask Agent opens this requirement's BA
// assistant room through the ISS-58 door
export function RequirementScreen({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  const q = useRequirement(projectId, reqKey);
  const [tab, setTab] = useRequirementTab();
  const [back, setBack] = useState(requirementsHref(slug));
  useEffect(() => setBack(listOrigin(slug)), [slug]);
  useChatDockDoor(useAssistantDoor(projectId, reqKey));
  const d = q.data;
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
        after={
          d ? (
            <span className="flex flex-none items-center gap-2 max-md:hidden">
              <span className="font-mono text-12 font-semibold text-muted" title={d.id}>
                {d.key}
              </span>
              <StateBadge state={d.standing.state} />
            </span>
          ) : null
        }
      >
        {d?.title ?? reqKey}
      </PageTitle>
      {d ? (
        <TopBarActions>
          <PrimaryActions projectId={projectId} slug={slug} d={d} onReview={() => setTab("revisions")} />
        </TopBarActions>
      ) : null}
      <RequirementPage projectId={projectId} slug={slug} reqKey={reqKey} tab={tab} onTab={setTab} />
    </div>
  );
}
