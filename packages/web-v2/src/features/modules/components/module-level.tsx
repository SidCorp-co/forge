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
  type ListGroup,
  type ListRowView,
  rememberListOrigin,
  useGroupFold,
  usePeek,
  usePeekKeys,
  ViewHeading,
  WaitingOn,
} from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { copyOr, type Copy } from "@/lib/i18n/product-copy";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { MODULES_LIST, moduleHref } from "@/lib/routes/modules";
import { useCodeTrace } from "../hooks";
import type { CodeTraceResponse, ModuleRollupResponse, ModuleRollupRow } from "../types";
import { moduleWaitingView, OpenBar } from "./module-bits";
import { ModuleMap } from "./module-map";
import { ModulePeek } from "./module-peek";

const columnsIn = (t: Copy) => ({ key: t("modules.col.key"), title: t("modules.col.title"), state: t("modules.col.state"), meta: t("modules.col.meta") });

const keyOf = (r: ModuleRollupRow) => r.slug ?? r.id;

type Trace = Map<string, string[]>;

/** The core modules of the build's trace, by name; a module label named after one shows its trace. */
function traceByModule(data: CodeTraceResponse | undefined): Trace | null {
  return data ? new Map(data.units.filter((u) => u.scope === "core").map((u) => [u.unit, u.serves])) : null;
}

const refLabel = (ref: string, t: Copy) => (ref.startsWith("via:") ? t("modules.trace.through", { ref: ref.slice(4) }) : ref);

function traceFact(r: ModuleRollupRow, trace: Trace | null, all: ModuleRollupRow[], t: Copy): string | null {
  if (!trace) return null;
  const own = trace.get(r.name);
  if (own) return own.length ? t("modules.trace.serves", { refs: own.map((x) => refLabel(x, t)).join(", ") }) : t("modules.trace.untraced");
  const traced = all.filter((c) => c.parentId === r.id && trace.has(c.name));
  if (traced.length === 0) return null;
  const untraced = traced.filter((c) => trace.get(c.name)?.length === 0).length;
  return untraced ? t("modules.trace.someUntraced", { n: untraced, of: traced.length }) : t("modules.trace.allTraced", { n: traced.length });
}

function factsOf(r: ModuleRollupRow, trace: Trace | null, all: ModuleRollupRow[], t: Copy): string[] {
  const s = r.standing;
  const parts = [t("modules.openCount", { n: s.open }), s.childCount ? t("modules.children", { n: s.childCount }) : t("modules.noChildren"), t("modules.requirementsCount", { n: s.requirements.length })];
  const traced = traceFact(r, trace, all, t);
  if (traced) parts.push(traced);
  if (r.description) parts.push(r.description);
  return parts;
}

const rowOf =
  (slug: string, max: number, trace: Trace | null, all: ModuleRollupRow[], t: Copy, language: string) =>
  (r: ModuleRollupRow): ListRowView => {
    const land = r.standing.lastLanding;
    return {
      key: keyOf(r),
      keyLabel: <span className="whitespace-normal break-all">{r.slug ?? r.id}</span>,
      href: moduleHref(slug, keyOf(r)),
      title: r.name,
      facts: factsOf(r, trace, all, t),
      state: <OpenBar standing={r.standing} max={max} />,
      waitingOn: <WaitingOn w={moduleWaitingView(r.standing, language)} />,
      owner: land ? <span className="font-mono text-11-5">{land.issueKey}</span> : <span className="text-subtle">{t("modules.noneYet")}</span>,
      age: land ? { text: formatAge(land.landedAt), title: t("modules.landedAt", { when: formatStamp(land.landedAt) }) } : null,
      dim: r.standing.attentionGroup === "quiet",
    };
  };

function groupOf(id: string, label: string, rows: ModuleRollupRow[], language: string): ListGroup<ModuleRollupRow> {
  return {
    id,
    label,
    tone: null,
    summary: MODULE_ATTENTION_GROUPS.filter((g) => g !== "quiet")
      .map((g) => ({ label: copyOr(language, `modules.attention.${g}`, MODULE_ATTENTION_LABELS[g].label), count: rows.filter((r) => r.standing.attentionGroup === g).length, tone: MODULE_ATTENTION_LABELS[g].tone }))
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
  const t = useCopy();
  const language = useInterfaceLanguage();
  const scopeId = scope?.id ?? null;
  const rows = useMemo(() => data.modules.filter((r) => (scopeId ? r.parentId === scopeId : r.depth === 0)), [data.modules, scopeId]);
  const couplings = useMemo(() => data.couplings.filter((c) => c.parentId === scopeId), [data.couplings, scopeId]);
  const max = useMemo(() => Math.max(1, ...rows.map((r) => r.standing.open)), [rows]);
  const groups = useMemo(() => [groupOf(scopeId ?? "roots", scope ? t("modules.in", { name: scope.name }) : t("modules.roots"), rows, language)], [scopeId, scope, rows, t, language]);
  const fold = useGroupFold("web-v2:modules-fold");
  const keys = useMemo(() => rows.map(keyOf), [rows]);
  const peek = usePeek(keys);
  const traceQ = useCodeTrace(projectId);
  const trace = useMemo(() => traceByModule(traceQ.data), [traceQ.data]);
  const row = useMemo(() => rowOf(slug, max, trace, data.modules, t, language), [slug, max, trace, data.modules, t, language]);

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
            {t("modules.truncated", { n: read.returned, open: read.open, older: unread })}
          </p>
        ) : null}
        <section className="px-5 pb-4 pt-5 max-md:px-3" data-testid="module-level-map">
          <ViewHeading
            right={
              couplings.length ? (
                <span className="text-12 text-subtle">{t("modules.map.lineWidth")}</span>
              ) : undefined
            }
          >
            {scope ? t("modules.inside", { name: scope.name }) : t("modules.business")}
          </ViewHeading>
          <ModuleMap rows={rows} couplings={couplings} selected={peek.open} onSelect={toggle} onOpen={open} />
          {couplings.length === 0 ? (
            <p className="mt-2 text-12-5 text-subtle" data-testid="module-map-no-couplings">
              {t("modules.map.noCoupling")}
            </p>
          ) : null}
        </section>
        <GroupedList ariaLabel={scope ? t("modules.in", { name: scope.name }) : t("modules.business")} groups={groups} fold={fold} row={row} selected={peek.open} onPeek={toggle} columns={columnsIn(t)} />
      </div>
      {peek.open ? <ModulePeek key={peek.open} projectId={projectId} slug={slug} moduleSlug={peek.open} peek={peek} onOpenFull={() => open(peek.open as string)} /> : null}
    </div>
  );
}
