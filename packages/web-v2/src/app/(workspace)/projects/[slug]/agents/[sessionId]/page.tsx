"use client";

import { useParams } from "next/navigation";
import { SessionScreen } from "@/features/session/components/session-screen";

export default function ProjectAgentSessionPage() {
  const params = useParams<{ slug: string; sessionId: string }>();
  const slug = params?.slug;
  const sessionId = params?.sessionId;

  if (!slug || !sessionId) return null;

  return <SessionScreen sessionId={sessionId} projectSlug={slug} />;
}
