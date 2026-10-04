"use client";

// One level of the module tree: the business modules (the roots) on the Modules screen, or one
// module's children on its page. A map of the level's modules and the couplings core rolled up to
// it, then the same modules as a flush list. A click on a node or a row opens the peek beside them;
// a double click, Enter, a modified click or the peek's open control goes to the module itself.

import { MODULE_ATTENTION_GROUPS, MODULE_ATTENTION_LABELS } from "@forge/contracts/modules";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useMemo } from "react";
import {
  GroupedList,
  LEGEND,
  type ListGroup,
  type ListRowView,
  rememberListOrigin,
  useGroupFold,
  usePeek,
  usePeekKeys,
  ViewHeading,
  WaitingOn,
} from "@/design";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { MODULES_LIST, moduleHref } from "../routes";
import type { ModuleRollupResponse, ModuleRollupRow } from "../types";
import { moduleWaitingView, OpenBar } from "./module-bits";
import { ModuleMap } from "./module-map";
import { ModulePeek } from "./module-peek";

const COLUMNS = { key: "Module", title: "Name", state: "Open issues", meta: "Last landing" } as const;

const keyOf = (r: ModuleRollupRow) => r.slug ?? r.id;

function factsOf(r: ModuleRollupRow): string[] {
  const s = r.standing;
  const parts = [`Open ${s.open}`, s.childCount ? `${s.childCount} child modules` : "No child modules", `Requirements ${s.requirements.length}`];
  if (r.description) parts.push(r.description);
  return parts;
}

const rowOf =
  (slug: string, max: number) =>
  (r: ModuleRollupRow): ListRowView => {
    const land = r.standing.lastLanding;
    return {
      key: keyOf(r),
      keyLabel: <span className="whitespace-normal break-all">{r.slug ?? r.id}</span>,
      href: moduleHref(slug, keyOf(r)),
      title: r.name,
      facts: factsOf(r),
      state: <OpenBar standing={r.standing} max={max} />,
      waitingOn: <WaitingOn w={moduleWaitingView(r.standing)} />,
      owner: land ? <span className="font-mono text-11-5">{land.issueKey}</span> : <span className="text-subtle">None yet</span>,
      age: land ? { text: formatAge(land.landedAt), title: `Landed ${formatStamp(land.landedAt)}` } : null,
      dim: r.standing.attentionGroup === "quiet",
    };
  };

function groupOf(id: string, label: string, rows: ModuleRollupRow[]): ListGroup<ModuleRollupRow> {
  return {
    id,
    label,
    tone: null,
    summary: MODULE_ATTENTION_GROUPS.filter((g) => g !== "quiet")
      .map((g) => ({ label: MODULE_ATTENTION_LABELS[g].label, count: rows.filter((r) => r.standing.attentionGroup === g).length, tone: MODULE_ATTENTION_LABELS[g].tone }))
      .filter((s) => s.count > 0),
    rows,
  };
}

export function ModuleLevel({
  projectId,
  slug,
  data,
  scope,
  toolbar,
}: {
  projectId: string;
  slug: string;
  data: ModuleRollupResponse;
  /** The module whose children this level shows; null for the roots. */
  scope: ModuleRollupRow | null;
  /** A strip above the map, drawn by the caller. */
  toolbar?: ReactNode;
}) {
  const router = useRouter();
  const scopeId = scope?.id ?? null;
  const rows = useMemo(() => data.modules.filter((r) => (scopeId ? r.parentId === scopeId : r.depth === 0)), [data.modules, scopeId]);
  const couplings = useMemo(() => data.couplings.filter((c) => c.parentId === scopeId), [data.couplings, scopeId]);
  const max = useMemo(() => Math.max(1, ...rows.map((r) => r.standing.open)), [rows]);
  const groups = useMemo(() => [groupOf(scopeId ?? "roots", scope ? `Modules in ${scope.name}` : "Root modules", rows)], [scopeId, scope, rows]);
  const fold = useGroupFold("web-v2:modules-fold");
  const keys = useMemo(() => rows.map(keyOf), [rows]);
  const peek = usePeek(keys);
  const row = useMemo(() => rowOf(slug, max), [slug, max]);

  const open = useCallback(
    (key: string) => {
      if (!scope) rememberListOrigin(MODULES_LIST);
      router.push(moduleHref(slug, key));
    },
    [router, slug, scope],
  );
  usePeekKeys(peek, open);
  const toggle = (k: string) => peek.set(k === peek.open ? null : k);

  const read = data.issuesRead;
  const unread = read.open - read.returned;

  return (
    <div className={cn("grid min-h-[60vh] items-start", peek.open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
      <div className="min-w-0">
        {toolbar}
        {unread > 0 ? (
          <p className="border-b border-line-subtle px-5 py-2 text-12-5 text-muted" data-testid="modules-truncated">
            The counts read the {read.returned} most recently written of {read.open} open issues; {unread} older ones are not in them.
          </p>
        ) : null}
        <section className="px-5 pb-4 pt-5 max-md:px-3" data-testid="module-level-map">
          <ViewHeading
            right={
              couplings.length ? (
                <span className="text-12 text-subtle">
                  Line width is the coupling&apos;s weight · <span style={{ color: LEGEND.err.fg }}>red</span> is declared both ways
                </span>
              ) : undefined
            }
          >
            {scope ? `Inside ${scope.name}` : "Business modules"}
          </ViewHeading>
          <ModuleMap rows={rows} couplings={couplings} selected={peek.open} onSelect={toggle} onOpen={open} />
          {couplings.length === 0 ? (
            <p className="mt-2 text-12-5 text-subtle" data-testid="module-map-no-couplings">
              No coupling between these modules: no knowledge-graph edge links two of them and no issue carries modules from two of them.
            </p>
          ) : null}
        </section>
        <GroupedList ariaLabel={scope ? `Modules in ${scope.name}` : "Business modules"} groups={groups} fold={fold} row={row} selected={peek.open} onPeek={toggle} columns={COLUMNS} />
      </div>
      {peek.open ? <ModulePeek key={peek.open} projectId={projectId} slug={slug} moduleSlug={peek.open} peek={peek} onOpenFull={() => open(peek.open as string)} /> : null}
    </div>
  );
}
