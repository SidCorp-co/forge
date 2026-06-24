"use client";

// Knowledge workspace — 7-inner-tab shell replacing the old edges-only screen.
// Tabs: Overview · Scenarios · Workflow · Rules · References · Graph · Memory
// Inner tab state is local (useState) — outer Library tab already URL deep-links via ?tab=.
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageContainer,
  ScreenTabs,
  Skeleton,
  type TabItem,
} from "@/design";
import { MemoryScreen } from "@/features/memory/components/memory-screen";
import { formatApiError } from "@/lib/api/error";
import { useKnowledgeEntries } from "../hooks";
import { EntryCard } from "./entry-card";
import { GraphTab } from "./graph-tab";
import { RulesTab } from "./rules-tab";

type KTab = "overview" | "scenarios" | "workflow" | "rules" | "references" | "graph" | "memory";

const KTABS: TabItem[] = [
  { value: "overview", label: "Overview" },
  { value: "scenarios", label: "Scenarios" },
  { value: "workflow", label: "Workflow" },
  { value: "rules", label: "Rules" },
  { value: "references", label: "References" },
  { value: "graph", label: "Graph" },
  { value: "memory", label: "Memory" },
];

interface KnowledgeScreenProps {
  scope: { projectId: string; canManage: boolean };
}

export function KnowledgeScreen({ scope }: KnowledgeScreenProps) {
  const { projectId, canManage } = scope;
  const [ktab, setKtab] = useState<KTab>("overview");

  return (
    <PageContainer className="min-h-dvh">
      <header className="mb-4">
        <h1 className="fg-h2">Knowledge</h1>
        <p className="fg-body-sm mt-1 text-muted">
          Curated product knowledge — visual diagrams, user journeys, rules, and references.
        </p>
      </header>

      <ScreenTabs
        tabs={KTABS}
        value={ktab}
        onChange={(v) => setKtab(v as KTab)}
        width="max-w-full"
      />

      <div className="mt-6">
        {ktab === "overview" && <OverviewTab projectId={projectId} canManage={canManage} />}
        {ktab === "scenarios" && (
          <EntriesTab
            projectId={projectId}
            canManage={canManage}
            kind="scenario"
            emptyTitle="No scenario entries yet"
            emptyMessage="Run forge-product-map bootstrap to generate user-journey flowcharts."
          />
        )}
        {ktab === "workflow" && (
          <EntriesTab
            projectId={projectId}
            canManage={canManage}
            kind="workflow"
            emptyTitle="No workflow entries yet"
            emptyMessage="Run forge-product-map bootstrap to generate state diagrams."
          />
        )}
        {ktab === "rules" && <RulesTab projectId={projectId} canManage={canManage} />}
        {ktab === "references" && <ReferencesTab projectId={projectId} canManage={canManage} />}
        {ktab === "graph" && <GraphTab projectId={projectId} canManage={canManage} />}
        {ktab === "memory" && <MemoryScreen scope={{ projectId }} />}
      </div>
    </PageContainer>
  );
}

function EntriesTab({
  projectId,
  canManage,
  kind,
  emptyTitle,
  emptyMessage,
}: {
  projectId: string;
  canManage: boolean;
  kind: string;
  emptyTitle: string;
  emptyMessage: string;
}) {
  const q = useKnowledgeEntries(projectId, kind);

  if (q.isLoading) {
    return (
      <div className="space-y-2.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <ErrorState
        title={`Couldn't load ${kind} entries`}
        message={formatApiError(q.error)}
        onRetry={() => q.refetch()}
      />
    );
  }

  const rows = q.data?.rows ?? [];
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} message={emptyMessage} />;
  }

  return (
    <div className="space-y-2.5">
      {rows.map((row) => (
        <EntryCard key={row.id} projectId={projectId} row={row} canManage={canManage} />
      ))}
    </div>
  );
}

function OverviewTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const q = useKnowledgeEntries(projectId, "overview");

  if (q.isLoading) return <Skeleton className="h-48 w-full rounded-lg" />;

  if (q.isError) {
    return (
      <ErrorState
        title="Couldn't load overview"
        message={formatApiError(q.error)}
        onRetry={() => q.refetch()}
      />
    );
  }

  const rows = q.data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No overview entry yet"
        message="Run forge-product-map bootstrap to generate a product overview mindmap."
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {rows.map((row, i) => (
        <EntryCard
          key={row.id}
          projectId={projectId}
          row={row}
          canManage={canManage}
          defaultOpen={i === 0}
        />
      ))}
    </div>
  );
}

function ReferencesTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const refQ = useKnowledgeEntries(projectId, "reference");
  const glossQ = useKnowledgeEntries(projectId, "glossary");

  const isLoading = refQ.isLoading || glossQ.isLoading;
  const isError = refQ.isError || glossQ.isError;

  if (isLoading) {
    return (
      <div className="space-y-2.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load references"
        message={formatApiError((refQ.error ?? glossQ.error) as Error)}
        onRetry={() => { refQ.refetch(); glossQ.refetch(); }}
      />
    );
  }

  const rows = [...(refQ.data?.rows ?? []), ...(glossQ.data?.rows ?? [])];

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No references yet"
        message="Add reference or glossary entries via the forge_knowledge MCP tool."
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {rows.map((row) => (
        <EntryCard key={row.id} projectId={projectId} row={row} canManage={canManage} />
      ))}
    </div>
  );
}
