import { redirect } from "next/navigation";
import { runsListHref } from "@/lib/routes/agents";

// `/agents/runs` with no run id is the Runs list, not a session named "runs": without this route the
// `agents/[sessionId]` segment took it and the page read "Couldn't load session — BAD_REQUEST".
export default async function RunsIndexPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(runsListHref(decodeURIComponent(slug)));
}
