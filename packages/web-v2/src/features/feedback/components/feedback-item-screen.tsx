"use client";

import Link from "next/link";
import { Icon, PageTitle } from "@/design";
import { feedbackListHref } from "../routes";
import { FeedbackDetailView } from "./feedback-detail";

export function FeedbackItemScreen({ projectId, slug, fbKey }: { projectId: string; slug: string; fbKey: string }) {
  return (
    <div className="grid content-start gap-4 px-4 pb-10 pt-4 sm:px-7" data-testid="feedback-item-screen">
      <PageTitle>{fbKey}</PageTitle>
      <Link
        href={feedbackListHref(slug)}
        className="inline-flex w-fit items-center gap-1 text-12 font-semibold text-muted hover:text-fg"
        data-testid="feedback-back"
      >
        <Icon name="chevronLeft" size={14} />
        Feedback
      </Link>
      <div className="max-w-3xl">
        <FeedbackDetailView projectId={projectId} slug={slug} fbKey={fbKey} full />
      </div>
    </div>
  );
}
