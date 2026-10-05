"use client";

import { useParams } from "next/navigation";
import { FeedbackItemScreen } from "@/features/feedback/components/feedback-item-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectFeedbackItemPage() {
  const params = useParams<{ slug: string; feedback: string }>();
  return (
    <ProjectGate label="loading feedback…">
      {(p) => <FeedbackItemScreen projectId={p.id} slug={p.slug} fbKey={decodeURIComponent(params.feedback)} />}
    </ProjectGate>
  );
}
