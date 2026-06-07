"use client";

// Project-tier agent-session detail (`/projects/[slug]/agents/[sessionId]`).
// Restores the run-conversation view (ISS-331): session rows on the Agents
// screen link here, and `SessionScreen` fetches by id + links back to the
// project Agents index via `projectSlug`. The detail component owns its own
// loading / error states, so this page is a thin param adapter.
import { useParams } from "next/navigation";
import { SessionScreen } from "@/features/session/components/session-screen";

export default function ProjectAgentSessionPage() {
  const params = useParams<{ slug: string; sessionId: string }>();
  const slug = params?.slug;
  const sessionId = params?.sessionId;

  if (!slug || !sessionId) return null;

  return <SessionScreen sessionId={sessionId} projectSlug={slug} />;
}
