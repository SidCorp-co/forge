import { useParams } from "react-router-dom";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";

export function KnowledgePage() {
  const { slug } = useParams<{ slug: string }>();

  return (
    <PageShell title="Knowledge" subtitle={`Project knowledge for ${slug}`} maxWidth="max-w-6xl">
      <EmptyState
        icon={<svg className="mx-auto h-10 w-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>}
        title="Knowledge is now in Postgres"
        description="Use forge_knowledge (list/get/search) in the agent chat, or manage entries via the web UI."
      />
    </PageShell>
  );
}
