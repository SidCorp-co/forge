"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  Kicker,
  PageContainer,
  PageTitle,
  Select,
  Skeleton,
  type SelectOption,
} from "@/design";
import { cn } from "@/lib/utils/cn";
import { formatApiError } from "@/lib/api/error";
import { useKnowledgeEntries } from "../hooks";
import { EntryCard } from "./entry-card";
import { DiagramsTab } from "./diagrams-tab";
import { GraphTab } from "./graph-tab";
import { RulesTab } from "./rules-tab";

/** Stable keys for the fixed-length loading skeleton — an array index as a React key is a
 *  lint diagnostic even where the list never reorders. */
const SKELETON_ROWS = ["s1", "s2", "s3"];

type KTab = "overview" | "diagrams" | "scenarios" | "workflow" | "rules" | "references" | "graph";

/** The seven readers, grouped by what they hold. A list rather than a second row of tabs: the
 *  Library's own tabs are the peers, and these are the contents of one of them. */
const KGROUPS: { label: string; readers: { value: KTab; label: string }[] }[] = [
  {
    label: "Product map",
    readers: [
      { value: "overview", label: "Overview" },
      { value: "scenarios", label: "Scenarios" },
      { value: "workflow", label: "Workflow" },
      { value: "diagrams", label: "Diagrams" },
      { value: "graph", label: "Graph" },
    ],
  },
  {
    label: "Rules and terms",
    readers: [
      { value: "rules", label: "Rules" },
      { value: "references", label: "References" },
    ],
  },
];

const KREADERS = KGROUPS.flatMap((g) => g.readers);
const KOPTIONS: SelectOption[] = KREADERS.map((r) => ({ value: r.value, label: r.label }));

interface KnowledgeScreenProps {
  scope: { projectId: string; canManage: boolean };
}

export function KnowledgeScreen({ scope }: KnowledgeScreenProps) {
  const { projectId, canManage } = scope;
  const sub = useSearchParams()?.get("sub");
  const [ktab, setKtab] = useState<KTab>(
    KREADERS.some((r) => r.value === sub) ? (sub as KTab) : "overview",
  );

  return (
    <PageContainer className="min-h-dvh">
      <header className="mb-4">
        <PageTitle className="fg-h2">Knowledge</PageTitle>
        <p className="fg-body-sm mt-1 text-muted">
          Curated product knowledge — visual diagrams, user journeys, rules, and references.
        </p>
      </header>

      <div className="mt-6 lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10">
        <nav aria-label="Knowledge readers" className="hidden space-y-5 lg:block">
          {KGROUPS.map((g) => (
            <div key={g.label}>
              <Kicker className="px-3">{g.label}</Kicker>
              <ul className="mt-1.5">
                {g.readers.map((r) => (
                  <li key={r.value}>
                    <button
                      type="button"
                      aria-current={r.value === ktab ? "page" : undefined}
                      onClick={() => setKtab(r.value)}
                      className={cn(
                        "block w-full border-l-2 px-3 py-1.5 text-left text-13-5 font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
                        r.value === ktab
                          ? "border-accent text-fg"
                          : "border-transparent text-muted hover:text-fg",
                      )}
                    >
                      {r.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="mb-4 lg:hidden">
          <Select
            options={KOPTIONS}
            value={ktab}
            onChange={(v) => setKtab(v as KTab)}
            aria-label="Knowledge reader"
            className="w-full"
          />
        </div>

        <div className="min-w-0">
          {ktab === "overview" && <OverviewTab projectId={projectId} canManage={canManage} />}
          {ktab === "diagrams" && <DiagramsTab projectId={projectId} />}
          {ktab === "scenarios" && (
            <EntriesTab
              projectId={projectId}
              canManage={canManage}
              kind="scenario"
              emptyTitle="No scenario entries yet"
              emptyWhat="user-journey flowcharts"
            />
          )}
          {ktab === "workflow" && (
            <EntriesTab
              projectId={projectId}
              canManage={canManage}
              kind="workflow"
              emptyTitle="No workflow entries yet"
              emptyWhat="state diagrams"
            />
          )}
          {ktab === "rules" && <RulesTab projectId={projectId} canManage={canManage} />}
          {ktab === "references" && <ReferencesTab projectId={projectId} canManage={canManage} />}
          {ktab === "graph" && <GraphTab projectId={projectId} canManage={canManage} />}
        </div>
      </div>
    </PageContainer>
  );
}

/** The product map is drawn by a schedule, so the way forward is the screen that runs it. An admin
 *  gets the button; anyone else is told what fills it, and nothing they cannot do. */
function ProductMapEmpty({
  title,
  what,
  canManage,
}: {
  title: string;
  what: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const slug = useParams<{ slug: string }>()?.slug;
  return (
    <EmptyState
      title={title}
      message={
        canManage
          ? `The product-map refresh schedule draws ${what}. Run it from Automation.`
          : `The project's product-map refresh schedule draws ${what}.`
      }
      action={
        canManage && slug
          ? { label: "Open Automation", onClick: () => router.push(`/projects/${slug}/automation`) }
          : undefined
      }
    />
  );
}

function EntriesTab({
  projectId,
  canManage,
  kind,
  emptyTitle,
  emptyWhat,
}: {
  projectId: string;
  canManage: boolean;
  kind: string;
  emptyTitle: string;
  emptyWhat: string;
}) {
  const q = useKnowledgeEntries(projectId, kind);

  if (q.isLoading) {
    return (
      <div className="space-y-2.5">
        {SKELETON_ROWS.map((k) => (
          <Skeleton key={k} className="h-14 w-full rounded-lg" />
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
    return <ProductMapEmpty title={emptyTitle} what={emptyWhat} canManage={canManage} />;
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
      <ProductMapEmpty title="No overview entry yet" what="the product overview mindmap" canManage={canManage} />
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
        {SKELETON_ROWS.map((k) => (
          <Skeleton key={k} className="h-14 w-full rounded-lg" />
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
        message="Reference and glossary entries appear here once the project's agents add them."
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
