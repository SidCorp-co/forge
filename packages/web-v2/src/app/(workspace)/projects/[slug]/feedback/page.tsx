"use client";

import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectFeedbackPage() {
  return (
    <ProjectGate label="loading feedback…">
      {(p) => <FeedbackScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
