"use client";

// Issues → Modules (ISS-949). The backlog read by module instead of by issue: every module of the
// project with its counts, the hierarchy it sits in, and the issues that belong to no module.
//
// Primary and secondary attributions are rendered as two separate lines and are never added
// together — an issue's primary module and its secondaries are different claims about it, and the
// whole axis exists to keep them apart. Each line says how much of it is the module's own and how
// much is inherited from its children.

import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState, Input, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useModuleRollup } from "../hooks";
import type { ModuleAttributionCounts, ModuleCounts, ModuleRollupRow } from "../types";

const INDENT_PER_DEPTH_PX = 16;

interface ModuleRollupViewProps {
  scope: { projectId: string; slug: string };
}

function CountLine({
  label,
  own,
  inherited,
  rollup,
}: {
  label: string;
  own: ModuleCounts;
  inherited: ModuleCounts;
  rollup: ModuleCounts;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="fg-body-sm w-20 shrink-0 text-muted">{label}</span>
      <span className="fg-body-sm">
        <span className="tabular-nums">{rollup.total}</span> total
      </span>
      <span className="fg-body-sm text-muted">
        <span className="tabular-nums">{rollup.open}</span> open ·{" "}
        <span className="tabular-nums">{rollup.closed}</span> closed ·{" "}
        <span className="tabular-nums">{rollup.recentlyActive}</span> active
      </span>
      <span className="fg-body-xs text-muted">
        (<span className="tabular-nums">{own.total}</span> own,{" "}
        <span className="tabular-nums">{inherited.total}</span> inherited)
      </span>
    </div>
  );
}

// cm:edge contract -> packages/web-v2/src/app/globals.css — the keyboard ring is app-wide in `@layer base`, so this row declares neither a `focus-visible:*` ring nor an unconditional `shadow-*`: either one replaces it silently (`design/focus-ring.test.ts`)
function ModuleCard({
  row,
  href,
}: {
  row: ModuleRollupRow;
  href: string;
}) {
  const lines: { label: string; key: keyof ModuleAttributionCounts }[] = [
    { label: "Primary", key: "primary" },
    { label: "Secondary", key: "secondary" },
  ];
  return (
    <li
      className="rounded-md border border-line p-3"
      style={{ marginLeft: row.depth * INDENT_PER_DEPTH_PX }}
    >
      <Link
        href={href}
        className="fg-body inline-flex items-center gap-2 rounded-sm font-medium hover:underline"
      >
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: row.color }}
        />
        {row.name}
      </Link>
      <div className="mt-2 flex flex-col gap-1">
        {lines.map(({ label, key }) => (
          <CountLine
            key={key}
            label={label}
            own={row.own[key]}
            inherited={row.inherited[key]}
            rollup={row.rollup[key]}
          />
        ))}
      </div>
    </li>
  );
}

function LoadingRows() {
  return (
    <ul className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="rounded-md border border-line p-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1 h-3 w-3/4" />
        </li>
      ))}
    </ul>
  );
}

export function ModuleRollupView({ scope }: ModuleRollupViewProps) {
  const { projectId, slug } = scope;
  const [search, setSearch] = useState("");
  const rollupQ = useModuleRollup(projectId);

  const modules = rollupQ.data?.modules ?? [];
  const term = search.trim().toLowerCase();
  const shown = useMemo(
    () => (term === "" ? modules : modules.filter((m) => m.name.toLowerCase().includes(term))),
    [modules, term],
  );

  if (rollupQ.isLoading) {
    return (
      <section aria-label="Modules" aria-busy="true">
        <LoadingRows />
      </section>
    );
  }

  if (rollupQ.isError) {
    return (
      <ErrorState
        message={formatApiError(rollupQ.error)}
        onRetry={() => {
          void rollupQ.refetch();
        }}
      />
    );
  }

  const unassigned = rollupQ.data?.unassigned;
  const activeWithinDays = rollupQ.data?.activeWithinDays ?? 0;

  if (modules.length === 0) {
    return (
      <EmptyState
        title="No modules yet"
        message="Create a module in project settings to read the backlog by area."
      />
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Modules">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search modules"
          aria-label="Search modules"
          icon="search"
          className="w-full sm:w-64"
        />
        <p className="fg-body-xs text-muted">Active = updated in the last {activeWithinDays} days</p>
      </div>

      {shown.length === 0 ? (
        // cm:why the filtered-empty state is its own copy and its own action — a project with no modules and a search that matched none read identically otherwise, and the fix for each is the opposite one
        <EmptyState
          title={`No modules match "${search.trim()}"`}
          message="Clear the search to see every module."
          mascot={false}
          action={{ label: "Clear search", onClick: () => setSearch("") }}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((row) => (
            <ModuleCard
              key={row.id}
              row={row}
              href={`/projects/${slug}/issues?tab=list&module=${row.id}`}
            />
          ))}
        </ul>
      )}

      {unassigned ? (
        // cm:guard the unattributed bucket is a row of its own and is never folded into a module — an issue with no module is a fact about the taxonomy's coverage, and folding it in reports coverage the modules do not have
        <div className="rounded-md border border-dashed border-line p-3">
          <p className="fg-body font-medium">No module</p>
          <p className="fg-body-sm mt-1 text-muted">
            <span className="tabular-nums">{unassigned.total}</span> total ·{" "}
            <span className="tabular-nums">{unassigned.open}</span> open ·{" "}
            <span className="tabular-nums">{unassigned.closed}</span> closed ·{" "}
            <span className="tabular-nums">{unassigned.recentlyActive}</span> active
          </p>
        </div>
      ) : null}
    </section>
  );
}
