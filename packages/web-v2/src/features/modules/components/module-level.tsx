
// One level of the module tree: the business modules (the roots) on the Modules screen, or one
// module's children on its page, as one flat grouped list led by each module's name (ISS-1072: the tile
// map above it repeated the same modules). A click on a row opens the peek beside it; Enter, a
// modified click or the peek's open control goes to the module itself. The slug is the row's tooltip
// and the issue that last landed is named in its age's.

import { MODULE_ATTENTION_GROUPS, MODULE_ATTENTION_LABELS } from "@forge/contracts/modules";
import type { ReactNode } from "react";
import { GroupedList, type ListGroup, type ListRowView, ListLayout, useListPage, WaitingOn } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { copyOr, type Copy } from "@/lib/i18n/product-copy";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { MODULES_LIST, moduleHref } from "@/lib/routes/modules";
import { useCodeTrace } from "../hooks";
import type { CodeTraceResponse, ModuleRollupResponse, ModuleRollupRow } from "../types";
import { moduleWaitingView, OpenBar } from "./module-bits";
import { ModulePeek } from "./module-peek";

const columnsIn = (t: Copy) => ({ title: t("modules.col.title"), state: t("modules.col.state"), meta: t("modules.col.meta") });

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
      href: moduleHref(slug, keyOf(r)),
      title: r.name,
      facts: factsOf(r, trace, all, t),
      state: <OpenBar standing={r.standing} max={max} />,
      waitingOn: <WaitingOn w={moduleWaitingView(r.standing, language)} />,
      owner: land ? null : <span className="text-subtle">{t("modules.noneYet")}</span>,
      age: land ? { text: formatAge(land.landedAt), title: `${land.title} (${land.issueKey}) · ${t("modules.landedAt", { when: formatStamp(land.landedAt) })}` } : null,
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
  const t = useCopy();
  const language = useInterfaceLanguage();
  const scopeId = scope?.id ?? null;
  const rows = data.modules.filter((r) => (scopeId ? r.parentId === scopeId : r.depth === 0));
  const max = Math.max(1, ...rows.map((r) => r.standing.open));
  const traceQ = useCodeTrace(projectId);
  const trace = traceByModule(traceQ.data);
  const list = useListPage({
    rows,
    keyOf,
    groupsOf: (shown) => [groupOf(scopeId ?? "roots", scope ? t("modules.in", { name: scope.name }) : t("modules.roots"), shown, language)],
    foldKey: "web-v2:modules-fold",
    stepsOf: (_groups, shown) => shown,
    hrefOf: (key) => moduleHref(slug, key),
    // a module's children open from its own page, which is not a list to go back to
    origin: scope ? null : MODULES_LIST,
  });
  const { peek, fullOf } = list;

  const read = data.issuesRead;
  const unread = read.open - read.returned;

  return (
    <ListLayout peek={peek.open ? <ModulePeek key={peek.open} projectId={projectId} slug={slug} moduleSlug={peek.open} peek={peek} full={fullOf(peek.open)} /> : null}>
        {toolbar}
        {unread > 0 ? (
          <p className="border-b border-line-subtle px-5 py-2 text-13 text-muted" data-testid="modules-truncated">
            {t("modules.truncated", { n: read.returned, open: read.open, older: unread })}
          </p>
        ) : null}
        <GroupedList ariaLabel={scope ? t("modules.in", { name: scope.name }) : t("modules.business")} groups={list.groups} fold={list.fold} row={rowOf(slug, max, trace, data.modules, t, language)} selected={peek.open} onPeek={list.togglePeek} columns={columnsIn(t)} keyColumn={false} />
    </ListLayout>
  );
}
