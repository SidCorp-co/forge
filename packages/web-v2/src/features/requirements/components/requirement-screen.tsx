"use client";

import Link from "next/link";
import { Icon, PageTitle } from "@/design";
import { requirementsHref } from "../routes";
import { RequirementDetailView } from "./requirement-detail";

export function RequirementScreen({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  return (
    <div className="grid content-start gap-4 px-4 pb-10 pt-4 sm:px-7" data-testid="requirement-screen">
      <PageTitle>{reqKey}</PageTitle>
      <Link
        href={requirementsHref(slug)}
        className="inline-flex w-fit items-center gap-1 text-12 font-semibold text-muted hover:text-fg"
        data-testid="requirement-back"
      >
        <Icon name="chevronLeft" size={14} />
        Requirements
      </Link>
      <div className="max-w-3xl">
        <RequirementDetailView projectId={projectId} slug={slug} reqKey={reqKey} full />
      </div>
    </div>
  );
}
