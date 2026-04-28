import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { KnowledgeViewer } from "@/components/settings/knowledge-viewer";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "@/hooks/use-tauri-ipc";
import { getProject } from "@/lib/api";
import type { KnowledgeIndex } from "@/lib/types";

export function KnowledgePage() {
  const { slug } = useParams<{ slug: string }>();
  const { config } = useAppStore();
  const projectConfig = slug ? config.projects[slug] : undefined;
  const repoPath = projectConfig?.repoPath ?? "";

  const { data: project } = useQuery({
    queryKey: ["project", slug],
    queryFn: () => getProject(slug!),
    enabled: !!slug,
  });

  const [localKnowledge, setLocalKnowledge] = useState<KnowledgeIndex | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!repoPath) return;
    setLoading(true);
    invoke<KnowledgeIndex | null>("read_knowledge_index", { repoPath })
      .then((data) => { if (data) setLocalKnowledge(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [repoPath]);

  // Normalize: Strapi may store flat KnowledgeIndex instead of Record<string, KnowledgeIndex>
  const raw = project?.knowledgeIndex;
  const strapiIndex = raw
    ? ('project' in raw || 'architecture' in raw || 'domains' in raw
        ? { [slug ?? "repo"]: raw }
        : raw)
    : null;
  const knowledgeIndex = strapiIndex
    ?? (localKnowledge?.project ? { [slug ?? "repo"]: localKnowledge } : null);

  return (
    <PageShell title="Knowledge" subtitle={`Indexed codebase structure for ${slug}`} maxWidth="max-w-6xl">
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-48 rounded" />
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      )}

      {!loading && knowledgeIndex && (
        <KnowledgeViewer knowledgeIndex={knowledgeIndex as Record<string, KnowledgeIndex>} />
      )}

      {!loading && !knowledgeIndex && (
        <EmptyState
          icon={<svg className="mx-auto h-10 w-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>}
          title="No knowledge index found"
          description='Go to Settings and click "Index Codebase" to generate one.'
        />
      )}
    </PageShell>
  );
}
